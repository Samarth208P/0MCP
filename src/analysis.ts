/**
 * Analysis Layer — rule extraction, contradiction scoring, and health metrics.
 *
 * Pure module: no filesystem I/O, no network calls, no side effects.
 * All functions are deterministic and synchronous.
 *
 * Design philosophy:
 *   - High-precision heuristics only. False positives are worse than missed detections.
 *   - Only surface drift warnings when confidence ≥ MIN_CONFIDENCE_THRESHOLD.
 *   - Keyword matching is case-insensitive and punctuation-tolerant.
 *
 * @module analysis
 */

import crypto from "node:crypto";
import { extractKeywords } from "./utils.js";
import type {
  MemoryEntry,
  DecisionRule,
  DriftFinding,
  IngestionEvent,
  MemoryHealthReport,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_CONFIDENCE_THRESHOLD = 0.7;
const STALE_THRESHOLD_DAYS = 30;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
const INGEST_TAG_PREFIX = "__ingest__";

// ── Rule Pattern Definitions ──────────────────────────────────────────────────

interface RulePattern {
  patterns: RegExp[];
  rule_type: DecisionRule["rule_type"];
  confidence: number;
}

const RULE_PATTERNS: RulePattern[] = [
  {
    // "must use X", "always use X", "we use X", "using X"
    patterns: [
      /\b(must use|always use|we use|we are using|we should use|stick with|go with)\s+(\S+)/gi,
    ],
    rule_type: "use",
    confidence: 0.85,
  },
  {
    // "must avoid X", "never use X", "don't use X", "do not use X"
    patterns: [
      /\b(must avoid|never use|don't use|do not use|avoid using|avoid)\s+(\S+)/gi,
    ],
    rule_type: "avoid",
    confidence: 0.9,
  },
  {
    // "the architecture is X", "we decided to use X", "going with X", "decided on X"
    patterns: [
      /\b(the architecture is|our architecture|we decided|decision is|going with|decided on|architecture choice)\b/gi,
    ],
    rule_type: "architecture",
    confidence: 0.75,
  },
  {
    // "contract at 0x...", "deployed at 0x...", "contract address is 0x..."
    patterns: [/\b(contract at|deployed at|contract address is|address is)\s+(0x[0-9a-fA-F]{40})/gi],
    rule_type: "contract",
    confidence: 0.95,
  },
  {
    // File ownership / convention patterns
    patterns: [
      /\b(owns?|responsible for|manages?)\s+(src\/|lib\/|tests?\/|components\/)\S*/gi,
      /\b(file convention|naming convention|folder structure)\b/gi,
    ],
    rule_type: "convention",
    confidence: 0.7,
  },
  {
    // "must X", "should always X", "never X"
    patterns: [/\b(must\b|should always|never\b|always\b)\s+\w+/gi],
    rule_type: "must",
    confidence: 0.72,
  },
];

// ── Contradiction Pattern Definitions ─────────────────────────────────────────

interface ContradictionPattern {
  /** matches in the incoming prompt */
  promptPatterns: RegExp[];
  /** matches against a decision rule's rule_text */
  ruleConflictFn: (ruleText: string, promptMatch: string) => boolean;
  reason: (ruleText: string, promptMatch: string) => string;
  severity: DriftFinding["severity"];
}

const CONTRADICTION_PATTERNS: ContradictionPattern[] = [
  {
    // "switch to X", "replace X with Y", "migrate to X", "moving to X"
    promptPatterns: [
      /\b(switch(?:ing)? to|replace .+ with|migrat(?:e|ing) to|moving to|move to)\s+(\S+)/gi,
    ],
    ruleConflictFn: (ruleText, promptMatch) => {
      const target = promptMatch.toLowerCase().replace(/[^a-z0-9]/g, "");
      // Conflict if the rule is about the thing being switched away FROM
      // i.e., the rule mentions a word that is NOT the switch target
      const ruleWords = ruleText.toLowerCase().split(/\s+/);
      return (
        (ruleText.includes("use") || ruleText.includes("always")) &&
        !ruleWords.some((w) => w.startsWith(target.slice(0, 4)))
      );
    },
    reason: (ruleText, promptMatch) =>
      `Prompt suggests "${promptMatch}" but existing rule says: "${ruleText.slice(0, 80)}"`,
    severity: "warning",
  },
  {
    // "use X" in prompt vs "avoid X" in rule (or vice versa)
    promptPatterns: [/\b(?:let's |we should |we'll )?use\s+(\S+)/gi],
    ruleConflictFn: (ruleText, promptMatch) => {
      const target = promptMatch.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        ruleText.includes("avoid") &&
        ruleText.toLowerCase().includes(target.slice(0, Math.max(4, target.length - 2)))
      );
    },
    reason: (ruleText, promptMatch) =>
      `Prompt wants to use "${promptMatch}" but existing rule avoids it: "${ruleText.slice(0, 80)}"`,
    severity: "warning",
  },
  {
    // New contract address vs existing rule with a different address
    promptPatterns: [/(0x[0-9a-fA-F]{40})/gi],
    ruleConflictFn: (ruleText, promptMatch) => {
      // Rule has a contract address that differs from the prompt's address
      const ruleAddressMatch = ruleText.match(/0x[0-9a-fA-F]{40}/i);
      return (
        ruleAddressMatch !== null &&
        ruleAddressMatch[0].toLowerCase() !== promptMatch.toLowerCase()
      );
    },
    reason: (ruleText, promptMatch) =>
      `New address ${promptMatch.slice(0, 12)}… conflicts with existing: ${ruleText.slice(0, 80)}`,
    severity: "warning",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ruleId(project_id: string, ruleText: string): string {
  return crypto
    .createHash("sha256")
    .update(`${project_id}:${ruleText}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isIngestEntry(entry: MemoryEntry): boolean {
  return entry.tags.some((t) => t.startsWith(INGEST_TAG_PREFIX));
}

// ── RULE EXTRACTION ───────────────────────────────────────────────────────────

/**
 * Scans all memory entries for decision-like phrases and returns a deduplicated
 * list of DecisionRule objects. Only rules at or above MIN_CONFIDENCE_THRESHOLD
 * are included.
 *
 * @param entries - All MemoryEntry records for the project
 * @returns Unique, high-confidence decision rules extracted from the corpus
 */
export function extractDecisionRules(entries: MemoryEntry[]): DecisionRule[] {
  const rulesMap = new Map<string, DecisionRule>();

  for (const entry of entries) {
    if (isIngestEntry(entry)) continue; // skip auto-ingested entries for rule extraction

    const corpus = `${entry.prompt} ${entry.response}`;
    const normalized = normalizeText(corpus);

    for (const { patterns, rule_type, confidence } of RULE_PATTERNS) {
      for (const pattern of patterns) {
        // Reset lastIndex for global regex reuse
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(normalized)) !== null) {
          const ruleText = match[0].slice(0, 200).trim();
          if (ruleText.length < 5) continue;
          if (confidence < MIN_CONFIDENCE_THRESHOLD) continue;

          const id = ruleId(entry.project_id, ruleText);
          if (!rulesMap.has(id)) {
            rulesMap.set(id, {
              id,
              project_id: entry.project_id,
              rule_text: ruleText,
              rule_type,
              file_paths: entry.file_paths,
              tags: entry.tags,
              source_entry_timestamp: entry.timestamp,
              confidence,
            });
          }
        }
      }
    }
  }

  // Sort by timestamp descending (newest rules first — more relevant)
  return Array.from(rulesMap.values()).sort(
    (a, b) => b.source_entry_timestamp - a.source_entry_timestamp
  );
}

// ── CONTRADICTION SCORING ─────────────────────────────────────────────────────

/**
 * Compares a new prompt against a set of existing decision rules and returns
 * high-confidence drift findings. Only findings where evidence is clear are
 * returned to avoid noisy false positives.
 *
 * @param prompt - The new user prompt to check
 * @param rules  - Extracted decision rules from existing memory
 * @returns List of detected contradictions, most severe first
 */
export function scoreContradiction(prompt: string, rules: DecisionRule[]): DriftFinding[] {
  if (rules.length === 0) return [];

  const normalizedPrompt = normalizeText(prompt);
  const findings: DriftFinding[] = [];
  const seenRuleIds = new Set<string>();

  for (const pattern of CONTRADICTION_PATTERNS) {
    for (const promptRegex of pattern.promptPatterns) {
      promptRegex.lastIndex = 0;
      let promptMatch: RegExpExecArray | null;

      while ((promptMatch = promptRegex.exec(normalizedPrompt)) !== null) {
        const matchedText = promptMatch[0];

        for (const rule of rules) {
          if (seenRuleIds.has(rule.id)) continue;

          const conflicts = pattern.ruleConflictFn(rule.rule_text, matchedText);
          if (conflicts) {
            seenRuleIds.add(rule.id);
            const promptExcerpt = prompt.slice(
              Math.max(0, promptMatch.index - 20),
              promptMatch.index + 60
            ).trim();

            findings.push({
              severity: pattern.severity,
              conflicting_rule: rule,
              conflict_reason: pattern.reason(rule.rule_text, matchedText).slice(0, 120),
              prompt_excerpt: promptExcerpt.slice(0, 80),
            });
          }
        }
      }
    }
  }

  // Warnings before infos, then by rule confidence descending
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "warning" ? -1 : 1;
    }
    return b.conflicting_rule.confidence - a.conflicting_rule.confidence;
  });
}

// ── HEALTH METRICS ────────────────────────────────────────────────────────────

/**
 * Computes a full MemoryHealthReport from a project's memory entries.
 * Also performs internal contradiction detection for the contradiction_count metric.
 *
 * @param entries    - All MemoryEntry records for the project
 * @param project_id - The project identifier
 * @returns Complete health report with warnings and recommendations
 */
export function computeHealthMetrics(
  entries: MemoryEntry[],
  project_id: string
): MemoryHealthReport {
  const now = Date.now();
  const warnings: string[] = [];
  const recommendations: string[] = [];

  const ingestEntries = entries.filter(isIngestEntry);
  const realEntries = entries.filter((e) => !isIngestEntry(e));

  // ── Basic counts ──────────────────────────────────────────────────────────

  const total_entries = entries.length;
  const ingested_entry_count = ingestEntries.length;
  const last_save_at = entries.length > 0
    ? Math.max(...entries.map((e) => e.timestamp))
    : null;

  // ── Average entry size ───────────────────────────────────────────────────

  const avg_entry_size_chars =
    entries.length > 0
      ? Math.round(
          entries.reduce((sum, e) => sum + e.prompt.length + e.response.length, 0) /
            entries.length
        )
      : 0;

  // ── Stale entries ────────────────────────────────────────────────────────

  const stale_entry_count = realEntries.filter(
    (e) => now - e.timestamp > STALE_THRESHOLD_MS
  ).length;

  // ── Tag coverage ─────────────────────────────────────────────────────────

  const taggedCount = realEntries.filter(
    (e) => e.tags.filter((t) => !t.startsWith("__")).length > 0
  ).length;
  const tag_coverage_pct =
    realEntries.length > 0
      ? Math.round((taggedCount / realEntries.length) * 100)
      : 0;

  // ── File-path coverage ───────────────────────────────────────────────────

  const withFilesCount = realEntries.filter((e) => e.file_paths.length > 0).length;
  const file_path_coverage_pct =
    realEntries.length > 0
      ? Math.round((withFilesCount / realEntries.length) * 100)
      : 0;

  // ── Duplicate detection (prompt fingerprint) ─────────────────────────────

  const promptFingerprints = entries.map((e) =>
    crypto
      .createHash("sha256")
      .update(e.prompt.toLowerCase().trim().slice(0, 200))
      .digest("hex")
      .slice(0, 12)
  );
  const uniqueFingerprints = new Set(promptFingerprints);
  const duplicateCount = promptFingerprints.length - uniqueFingerprints.size;
  const duplicate_rate_pct =
    entries.length > 0 ? Math.round((duplicateCount / entries.length) * 100) : 0;

  // ── Contradiction count ───────────────────────────────────────────────────

  const rules = extractDecisionRules(realEntries);
  let contradiction_count = 0;
  const seenPairs = new Set<string>();

  for (const entry of realEntries) {
    const findings = scoreContradiction(entry.prompt, rules);
    for (const f of findings) {
      const pairKey = `${f.conflicting_rule.id}:${entry.timestamp}`;
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        contradiction_count++;
      }
    }
  }

  // ── Warnings ──────────────────────────────────────────────────────────────

  if (total_entries === 0) {
    warnings.push("No memory entries found for this project.");
    recommendations.push("Start a session and call save_memory after important decisions.");
  }

  if (last_save_at !== null && now - last_save_at > 14 * 24 * 60 * 60 * 1000) {
    const days = Math.floor((now - last_save_at) / (24 * 60 * 60 * 1000));
    warnings.push(`No memory saved in ${days} days.`);
    recommendations.push("Regular saves help the agent stay aligned with project decisions.");
  }

  if (contradiction_count > 5) {
    warnings.push(`High contradiction rate: ${contradiction_count} conflicts detected.`);
    recommendations.push(
      "Review old decisions with `0mcp memory list` and remove or reconcile conflicting entries."
    );
  }

  if (realEntries.length > 0 && file_path_coverage_pct < 20) {
    warnings.push(`Low file-path coverage: only ${file_path_coverage_pct}% of entries reference files.`);
    recommendations.push(
      "Include relevant file_paths when calling save_memory to improve retrieval precision."
    );
  }

  if (realEntries.length > 0 && tag_coverage_pct < 30) {
    warnings.push(`Low tag coverage: only ${tag_coverage_pct}% of entries have meaningful tags.`);
    recommendations.push(
      "Add tags (e.g. 'architecture', 'decision', 'bug-fix') to improve context retrieval."
    );
  }

  if (duplicate_rate_pct > 15) {
    warnings.push(`High duplicate rate: ~${duplicate_rate_pct}% of entries share similar prompts.`);
    recommendations.push(
      "Deduplicate redundant entries by exporting the snapshot and pruning."
    );
  }

  if (stale_entry_count > 0 && stale_entry_count >= Math.max(3, Math.floor(realEntries.length * 0.4))) {
    warnings.push(
      `${stale_entry_count} entries are older than ${STALE_THRESHOLD_DAYS} days and may be stale.`
    );
    recommendations.push(
      "Use `0mcp memory export` to review and prune outdated entries."
    );
  }

  return {
    generated_at: now,
    project_id,
    total_entries,
    last_save_at,
    avg_entry_size_chars,
    stale_entry_count,
    contradiction_count,
    tag_coverage_pct,
    file_path_coverage_pct,
    duplicate_rate_pct,
    ingested_entry_count,
    warnings,
    recommendations,
  };
}

// ── INGESTION EVENT CLASSIFICATION ────────────────────────────────────────────

/**
 * Classifies a raw commit message and file diff into an IngestionEvent.
 * Used by src/ingest.ts to normalise git output into typed events.
 *
 * @param commitMessage - Raw git commit message
 * @param changedFiles  - List of files changed in this commit
 * @param commitHash    - Full commit hash (used as fingerprint)
 * @param timestamp     - Commit Unix ms timestamp
 * @returns Classified IngestionEvent
 */
export function classifyIngestionEvent(
  commitMessage: string,
  changedFiles: string[],
  commitHash: string,
  timestamp: number,
  projectId: string
): IngestionEvent {
  const lower = commitMessage.toLowerCase();
  const kws = extractKeywords(lower);

  let event_type: IngestionEvent["event_type"] = "commit";

  // Order matters — more specific checks first
  if (/\bbreak(?:ing)?\b/.test(lower) || lower.startsWith("!")) {
    event_type = "breaking_change";
  } else if (/\bfix(?:es|ed|ing)?\b|\bbug\b/.test(lower)) {
    event_type = "bug_fix";
  } else if (/\brefactor\b/.test(lower)) {
    event_type = "refactor";
  } else if (
    /\bdep(?:endency|endencies|s)\b|\bpackage\.json\b|\bpackage-lock\b/.test(lower) ||
    changedFiles.some((f) => f.endsWith("package.json") || f.endsWith("package-lock.json"))
  ) {
    event_type = "dependency_update";
  } else if (
    /\barchitect(?:ure|ural)?\b|\bdesign\b|\bstructure\b/.test(lower) ||
    changedFiles.some((f) =>
      /ARCHITECTURE|README|DESIGN/i.test(f)
    )
  ) {
    event_type = "architecture_change";
  } else if (/\btest(?:s|ing)?\b|\bspec\b/.test(lower)) {
    event_type = "operational_note";
  }

  // Build a compact summary
  const summary = [
    `[${event_type.replace(/_/g, "-")}] ${commitMessage.slice(0, 120).trim()}`,
    changedFiles.length > 0
      ? `Files: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    event_type,
    source: "git",
    fingerprint: commitHash,
    summary,
    file_paths: changedFiles,
    timestamp,
    raw_metadata: {
      commit_hash: commitHash,
      commit_message: commitMessage,
      keywords: kws,
      project_id: projectId,
    },
  };
}

// ── FORMAT HELPERS (used by context.ts and health.ts) ────────────────────────

/**
 * Formats a list of DriftFindings into a short, readable warning block
 * suitable for injection into the context string or terminal output.
 *
 * @param findings - Drift findings returned by scoreContradiction()
 * @returns Formatted warning block, or "" if findings is empty
 */
export function formatDriftBlock(findings: DriftFinding[]): string {
  if (findings.length === 0) return "";

  const lines: string[] = [
    "",
    "=== DRIFT WARNINGS (from 0MCP analysis) ===",
    `Found ${findings.length} potential conflict${findings.length > 1 ? "s" : ""} with past decisions:`,
    "",
  ];

  findings.forEach((f, i) => {
    const icon = f.severity === "warning" ? "⚠" : "ℹ";
    const date = new Date(f.conflicting_rule.source_entry_timestamp)
      .toISOString()
      .split("T")[0];
    lines.push(`${icon} Conflict ${i + 1} (${date}):`);
    lines.push(`  Reason:  ${f.conflict_reason}`);
    lines.push(`  Excerpt: "${f.prompt_excerpt}"`);
    lines.push(`  Rule:    "${f.conflicting_rule.rule_text.slice(0, 100)}"`);
    lines.push("");
  });

  lines.push("=== END OF DRIFT WARNINGS ===");
  return lines.join("\n");
}
