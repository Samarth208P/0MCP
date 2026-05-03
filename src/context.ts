/**
 * Context Engine — keyword-based retrieval and injection from 0G storage.
 *
 * Pure deterministic logic. No embeddings. No external API. Zero cost.
 *
 * Algorithm:
 *   Score = 0.7 × (matching keywords / query keywords) + 0.3 × (recency 0–1)
 *   Only entries with score > 0 are injected.
 *
 * Drift detection runs on every call (always-on by default). It appends a
 * === DRIFT WARNINGS === block when contradictions against past decisions
 * are detected. Can be suppressed via options.includeDriftWarnings = false.
 *
 * @module context
 */

import { loadAllEntries } from "./storage.js";
import { extractKeywords } from "./utils.js";
import { extractDecisionRules, scoreContradiction, formatDriftBlock } from "./analysis.js";
import type { MemoryEntry } from "./types.js";

// ── Scoring constants ─────────────────────────────────────────────────────────

const RECENCY_WEIGHT = 0.3;
const KEYWORD_WEIGHT = 0.7;

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
  overlap: number;
  keywordsMatched: string[];
}

// ── OPTIONS ───────────────────────────────────────────────────────────────────

export interface BuildContextOptions {
  /**
   * When true, runs contradiction detection against extracted decision rules
   * and appends a DRIFT WARNINGS block to the context string.
   * Defaults to true (always-on). Set false to suppress for low-latency paths.
   */
  includeDriftWarnings?: boolean;
}

// ── SCORING ───────────────────────────────────────────────────────────────────

/**
 * Scores a single MemoryEntry against the current query keywords.
 *
 * @param entry - The memory entry to score
 * @param queryKeywords - Keywords extracted from the current prompt
 * @param now - Current timestamp in ms (for recency normalisation)
 * @param oldestTimestamp - Oldest entry's timestamp (for normalisation floor)
 * @returns Score between 0 and 1
 */
export function scoreEntry(
  entry: MemoryEntry,
  queryKeywords: string[],
  now: number,
  oldestTimestamp: number
): { score: number; matched: string[] } {
  // Build the full entry text corpus for keyword matching
  const entryText = `${entry.prompt} ${entry.response} ${entry.tags.join(" ")}`.toLowerCase();
  const entryKeywords = extractKeywords(entryText);

  // Keyword overlap: fraction of query keywords that appear in the entry
  const matched = queryKeywords.filter((kw) => entryKeywords.includes(kw));
  const keywordScore = queryKeywords.length > 0 ? matched.length / queryKeywords.length : 0;

  // Recency score: normalised 0–1, where 1 = most recent
  const timeRange = now - oldestTimestamp || 1;
  const recencyScore = (entry.timestamp - oldestTimestamp) / timeRange;

  const score = KEYWORD_WEIGHT * keywordScore + RECENCY_WEIGHT * recencyScore;
  return { score, matched };
}

// ── FORMATTING ────────────────────────────────────────────────────────────────

/**
 * Formats a list of MemoryEntries into a structured block for LLM injection.
 * Keeps each entry summary short to stay within token budgets.
 *
 * @param entries - Ranked and filtered entries to format
 * @returns Formatted string ready for injection into the system prompt
 */
export function formatContextBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [
    "=== PROJECT MEMORY (from 0G decentralised storage) ===",
    `Retrieved ${entries.length} relevant past interaction${entries.length > 1 ? "s" : ""}:`,
    "",
  ];

  entries.forEach((entry, i) => {
    const date = new Date(entry.timestamp).toISOString().split("T")[0];
    lines.push(`--- Memory ${i + 1} (${date}) ---`);
    if (entry.file_paths.length > 0) {
      lines.push(`Files: ${entry.file_paths.join(", ")}`);
    }
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.join(", ")}`);
    }
    // Truncate to keep token usage bounded
    lines.push(`Prompt: ${entry.prompt.slice(0, 200)}${entry.prompt.length > 200 ? "…" : ""}`);
    lines.push(
      `Response: ${entry.response.slice(0, 300)}${entry.response.length > 300 ? "…" : ""}`
    );
    lines.push("");
  });

  lines.push("=== END OF PROJECT MEMORY ===");
  lines.push("Use the above context to inform your response. Prioritise recent decisions.");

  return lines.join("\n");
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

/**
 * Retrieves relevant past interactions from 0G and returns a formatted
 * context block ready for injection into the LLM system prompt.
 *
 * Steps:
 *   1. Load all entries for the project from storage
 *   2. Extract keywords from the current prompt
 *   3. Score every entry: 0.7 × keyword overlap + 0.3 × recency
 *   4. Keep only entries with score > 0, take top N
 *   5. Format into a structured block
 *   6. Run drift detection and append warnings (always-on, best-effort)
 *
 * @param project_id - Project identifier
 * @param prompt - The user's current prompt
 * @param maxEntries - Maximum number of entries to inject (default 5)
 * @param options - Optional configuration (drift warnings override, etc.)
 * @returns Formatted context string, or "" if no relevant entries found
 */
export async function buildContext(
  project_id: string,
  prompt: string,
  maxEntries = 5,
  options: BuildContextOptions = {}
): Promise<string> {
  const allEntries = await loadAllEntries(project_id);
  if (allEntries.length === 0) return "";

  const queryKeywords = extractKeywords(prompt);
  const now = Date.now();
  const oldest = Math.min(...allEntries.map((e) => e.timestamp));

  // Score every entry
  const scored: ScoredEntry[] = allEntries.map((entry) => {
    const { score, matched } = scoreEntry(entry, queryKeywords, now, oldest);
    return { entry, score, overlap: matched.length, keywordsMatched: matched };
  });

  if (process.env.DEBUG_CONTEXT === "true") {
    console.error("\n0MCP CONTEXT RETRIEVAL DEBUG:");
    console.error(`  Query keywords: [${queryKeywords.join(", ")}]`);
    console.error(`  Total entries in 0G: ${allEntries.length}`);
    scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .forEach((s) => {
        const date = new Date(s.entry.timestamp).toISOString().split("T")[0];
        console.error(
          `  Score ${s.score.toFixed(3)} | ${date} | matched:[${s.keywordsMatched.join(",")}] | "${s.entry.prompt.slice(0, 60)}…"`
        );
      });
  }

  // Sort by score desc, filter irrelevant (score = 0), take top N
  const topEntries = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries)
    .filter((s) => s.score > 0)
    .map((s) => s.entry);

  if (process.env.DEBUG_CONTEXT === "true") {
    console.error(`  Injecting top ${topEntries.length} entries.\n`);
  }

  let contextBlock = formatContextBlock(topEntries);

  // ── Drift detection (always-on by default, best-effort) ──────────────────
  // Default: enabled unless ENABLE_DRIFT_DETECTION=false or caller sets false
  const enableDrift =
    options.includeDriftWarnings ??
    process.env.ENABLE_DRIFT_DETECTION !== "false";

  if (enableDrift && allEntries.length > 0) {
    try {
      const rules = extractDecisionRules(allEntries);
      if (rules.length > 0) {
        const findings = scoreContradiction(prompt, rules);
        if (findings.length > 0) {
          const driftBlock = formatDriftBlock(findings);
          contextBlock = contextBlock
            ? contextBlock + "\n" + driftBlock
            : driftBlock;

          if (process.env.DEBUG_CONTEXT === "true") {
            console.error(`  Drift warnings: ${findings.length} finding(s) appended.`);
          }
        }
      }
    } catch (analysisErr) {
      // Drift detection is best-effort — never block context retrieval
      console.error(`[context] Drift analysis error (non-fatal): ${analysisErr}`);
    }
  }

  return contextBlock;
}
