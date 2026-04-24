---
name: 0mcp-context-engine
description: Use this skill when building the context retrieval and injection logic — the part that takes a user prompt, finds relevant past entries from 0G storage, and formats them for injection into the LLM system prompt. Triggers when asked to implement buildContext, extractKeywords, rankEntries, or formatContextBlock.
---

# Context Engine — Build Guide

## What This Skill Builds

`src/context.ts` — the intelligence layer of 0MCP.

Given a prompt and a project ID, it:
1. Extracts keywords from the prompt
2. Loads all memory entries for the project from 0G
3. Scores each entry by keyword overlap + recency
4. Returns the top N entries formatted for LLM injection

**No embeddings. No external API. Pure deterministic logic.**
This is intentional — it's transparent, explainable, and works at $0 cost.

## Full Context Module (src/context.ts)

```typescript
import { loadAllEntries } from "./storage.js";
import type { MemoryEntry } from "./types.js";

// ── KEYWORD EXTRACTION ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","is","it","in","on","at","to","for","of","and","or",
  "but","not","with","this","that","was","are","be","have","has","do",
  "does","did","will","would","could","should","can","may","might",
  "i","you","we","they","he","she","my","your","their","our","what",
  "how","why","when","where","which","who","please","help","make",
  "create","use","get","set","add","remove","update","fix","write",
  "give","me","from","into","about","like","just","also","need","want",
]);

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")   // strip punctuation
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // dedupe
}

// ── SCORING ─────────────────────────────────────────────────────────────────

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

const RECENCY_WEIGHT = 0.3;    // 30% of score from recency
const KEYWORD_WEIGHT = 0.7;    // 70% of score from keyword overlap

export function scoreEntry(
  entry: MemoryEntry,
  queryKeywords: string[],
  now: number,
  oldestTimestamp: number
): number {
  // Keyword score: what fraction of query keywords appear in the entry
  const entryText = `${entry.prompt} ${entry.response} ${entry.tags.join(" ")}`.toLowerCase();
  const entryKeywords = extractKeywords(entryText);
  const overlap = queryKeywords.filter((kw) => entryKeywords.includes(kw)).length;
  const keywordScore = queryKeywords.length > 0 ? overlap / queryKeywords.length : 0;

  // Recency score: normalized 0–1, newer = higher
  const timeRange = now - oldestTimestamp || 1;
  const recencyScore = (entry.timestamp - oldestTimestamp) / timeRange;

  return KEYWORD_WEIGHT * keywordScore + RECENCY_WEIGHT * recencyScore;
}

// ── FORMATTING ───────────────────────────────────────────────────────────────

export function formatContextBlock(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";

  const lines = [
    "=== PROJECT MEMORY (from 0G decentralized storage) ===",
    `Retrieved ${entries.length} relevant past interactions:`,
    "",
  ];

  entries.forEach((entry, i) => {
    const date = new Date(entry.timestamp).toISOString().split("T")[0];
    lines.push(`--- Memory ${i + 1} (${date}) ---`);
    if (entry.file_paths.length > 0) {
      lines.push(`Files: ${entry.file_paths.join(", ")}`);
    }
    lines.push(`Prompt: ${entry.prompt.slice(0, 200)}${entry.prompt.length > 200 ? "..." : ""}`);
    lines.push(`Response summary: ${entry.response.slice(0, 300)}${entry.response.length > 300 ? "..." : ""}`);
    lines.push("");
  });

  lines.push("=== END OF PROJECT MEMORY ===");
  lines.push("Use the above context to inform your response. Prioritize recent decisions.");

  return lines.join("\n");
}

// ── MAIN EXPORT ──────────────────────────────────────────────────────────────

export async function buildContext(
  project_id: string,
  prompt: string,
  maxEntries: number = 5
): Promise<string> {
  // 1. Load all entries from 0G
  const allEntries = await loadAllEntries(project_id);
  if (allEntries.length === 0) return "";

  // 2. Extract keywords from current prompt
  const queryKeywords = extractKeywords(prompt);

  // 3. Score all entries
  const now = Date.now();
  const oldest = Math.min(...allEntries.map((e) => e.timestamp));

  const scored: ScoredEntry[] = allEntries.map((entry) => ({
    entry,
    score: scoreEntry(entry, queryKeywords, now, oldest),
  }));

  // 4. Sort by score descending, take top N
  const topEntries = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries)
    .filter((s) => s.score > 0)   // only include entries with actual relevance
    .map((s) => s.entry);

  // 5. Format for injection
  return formatContextBlock(topEntries);
}
```

## How the Scoring Works (explain this in your demo)

```
Score = 0.7 × (matching keywords / query keywords) + 0.3 × (recency)

Example:
  Query: "fix the authentication bug in middleware"
  Keywords extracted: ["fix", "authentication", "bug", "middleware"]

  Entry A (yesterday): mentions "authentication", "middleware", "token"
    → keyword overlap = 2/4 = 0.5, recency = 0.95
    → score = 0.7(0.5) + 0.3(0.95) = 0.35 + 0.285 = 0.635 ✅

  Entry B (last week): mentions "database", "query", "index"
    → keyword overlap = 0/4 = 0, recency = 0.2
    → score = 0 + 0.06 = 0.06 ❌ (filtered out, score too low)
```

This is the part to show during the demo — paste the score breakdown into terminal output.

## Debug Mode (add this for the demo)

```typescript
// In buildContext(), add this for demo visibility:
if (process.env.DEBUG_CONTEXT === "true") {
  console.error("\n🧠 0MCP CONTEXT RETRIEVAL DEBUG:");
  console.error(`Query keywords: [${queryKeywords.join(", ")}]`);
  console.error(`Total entries in 0G: ${allEntries.length}`);
  scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .forEach((s) => {
      console.error(`  Score ${s.score.toFixed(3)} | ${new Date(s.entry.timestamp).toISOString().split("T")[0]} | "${s.entry.prompt.slice(0, 60)}..."`);
    });
  console.error(`Injecting top ${topEntries.length} entries.\n`);
}
```

## Definition of Done

- [ ] `extractKeywords("fix the auth bug in middleware")` returns `["fix", "auth", "bug", "middleware"]`
- [ ] `buildContext` returns empty string when no entries exist (no crash)
- [ ] `buildContext` returns formatted block when matching entries exist
- [ ] Score of 0 entries are filtered out (don't inject irrelevant noise)
- [ ] Context block is under 2000 tokens for typical usage
