/**
 * Repo-Aware Ingestion Pipeline — auto-learns from git history.
 *
 * Reads git commit history and file diffs, classifies them into typed
 * IngestionEvent records, deduplicates against a local state file, and
 * persists new events as MemoryEntry records in 0G storage.
 *
 * Deduplication state is stored locally at <repoPath>/.0mcp-ingest-state.json
 * (cheap — no on-chain cost per commit hash lookup).
 *
 * @module ingest
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveMemory, loadAllEntries } from "./storage.js";
import { classifyIngestionEvent } from "./analysis.js";
import type { MemoryEntry, IngestionEvent } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const INGEST_STATE_FILE = ".0mcp-ingest-state.json";
const INGEST_TAG_PREFIX = "__ingest__";
const MAX_COMMITS_DEFAULT = 50;

// ── Ingest State (local dedup) ────────────────────────────────────────────────

interface IngestState {
  version: "1.0";
  project_id: string;
  ingested_fingerprints: string[];
  last_run_at: number;
}

function stateFilePath(repoPath: string): string {
  return path.join(repoPath, INGEST_STATE_FILE);
}

function loadIngestState(repoPath: string, project_id: string): IngestState {
  const filePath = stateFilePath(repoPath);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as IngestState;
      if (parsed.project_id === project_id) return parsed;
    } catch {
      // Corrupt state — start fresh
    }
  }
  return {
    version: "1.0",
    project_id,
    ingested_fingerprints: [],
    last_run_at: 0,
  };
}

function saveIngestState(repoPath: string, state: IngestState): void {
  const filePath = stateFilePath(repoPath);
  // Keep the fingerprint list bounded to avoid unbounded growth
  if (state.ingested_fingerprints.length > 5000) {
    state.ingested_fingerprints = state.ingested_fingerprints.slice(-4000);
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

// ── Git Collectors ────────────────────────────────────────────────────────────

interface RawCommit {
  hash: string;
  message: string;
  author: string;
  date: string; // ISO string
  changedFiles: string[];
}

/**
 * Reads recent commits from a git repository using `git log`.
 *
 * @param repoPath  - Absolute path to the git repository root
 * @param since     - Optional git ref or date (e.g. "HEAD~10", "2024-01-01")
 * @param maxCount  - Maximum number of commits to read
 * @returns Array of raw commit objects
 */
export function collectGitCommits(
  repoPath: string,
  since?: string,
  maxCount = MAX_COMMITS_DEFAULT
): RawCommit[] {
  const sinceFlag = since ? `${since}..HEAD` : "";
  const maxFlag = `--max-count=${maxCount}`;

  // Use a separator that is safe on all shells (no |, no <>, no &)
  const SEP = "XCOMMITSEPX";
  const FORMAT = `--pretty=format:${SEP}%H%n%s%n%an%n%aI`;

  let rawLog: string;
  try {
    rawLog = execSync(
      `git log ${maxFlag} "${FORMAT}" --name-only ${sinceFlag}`,
      {
        cwd: repoPath,
        encoding: "utf8",
        // Use shell:false equivalent by avoiding shell meta-chars;
        // on Windows, execSync wraps in cmd.exe by default
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
  } catch (err) {
    throw new Error(
      `git log failed in ${repoPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Ensure git is installed and the path is a valid git repository.`
    );
  }

  const commits: RawCommit[] = [];
  const blocks = rawLog.split("XCOMMITSEPX").filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l !== "");
    if (lines.length < 4) continue;

    const [hash, message, author, date, , ...fileLines] = lines;
    const changedFiles = fileLines
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !f.startsWith(" "));

    if (!hash || hash.length < 7) continue;

    commits.push({
      hash: hash.trim(),
      message: (message ?? "").trim(),
      author: (author ?? "").trim(),
      date: (date ?? new Date().toISOString()).trim(),
      changedFiles,
    });
  }

  return commits;
}

/**
 * Deduplicates a list of IngestionEvents against already-ingested fingerprints.
 *
 * @param events                - Candidate events to check
 * @param existingFingerprints  - Set of already-processed fingerprints
 * @returns Only the events not yet ingested
 */
export function deduplicateEvents(
  events: IngestionEvent[],
  existingFingerprints: Set<string>
): IngestionEvent[] {
  return events.filter((e) => !existingFingerprints.has(e.fingerprint));
}

/**
 * Converts a list of IngestionEvents into MemoryEntry records suitable
 * for storage. Related events are bundled into a single entry when possible
 * to reduce storage overhead.
 *
 * @param events      - Deduplicated events to convert
 * @param project_id  - Project identifier
 * @param batchSize   - Max events to bundle per MemoryEntry (default 5)
 * @returns Array of MemoryEntry records ready for saveMemory()
 */
export function bundleEventsAsMemoryEntries(
  events: IngestionEvent[],
  project_id: string,
  batchSize = 5
): MemoryEntry[] {
  if (events.length === 0) return [];

  const entries: MemoryEntry[] = [];

  // Group events into batches
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);

    // Use the most recent event's timestamp for the entry
    const latestTimestamp = Math.max(...batch.map((e) => e.timestamp));

    const allFiles = [...new Set(batch.flatMap((e) => e.file_paths))];
    const eventTypes = [...new Set(batch.map((e) => e.event_type))];

    // Build prompt: describes what happened
    const prompt = batch
      .map((e) => `[${e.event_type.replace(/_/g, "-")}] ${e.summary}`)
      .join("\n");

    // Build response: structured summary of the batch
    const response = [
      `Auto-ingested ${batch.length} repo event${batch.length > 1 ? "s" : ""} from git history.`,
      `Event types: ${eventTypes.join(", ")}`,
      `Fingerprints: ${batch.map((e) => e.fingerprint.slice(0, 8)).join(", ")}`,
    ].join("\n");

    const tags = [
      INGEST_TAG_PREFIX,
      ...eventTypes.map((t) => `${INGEST_TAG_PREFIX}${t}`),
      "git",
    ];

    entries.push({
      project_id,
      prompt,
      response,
      file_paths: allFiles.slice(0, 20), // cap to avoid oversized entries
      tags,
      timestamp: latestTimestamp,
    });
  }

  return entries;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface IngestionOptions {
  /** Git ref or date to start from. Defaults to last N commits. */
  since?: string;
  /** Maximum commits to read per run. Defaults to 50. */
  maxCommits?: number;
  /** How many events to bundle per MemoryEntry. Defaults to 5. */
  batchSize?: number;
  /** If true, skip writing to 0G storage (dry run). */
  dryRun?: boolean;
}

export interface IngestionResult {
  saved: number;
  skipped: number;
  events: IngestionEvent[];
  new_entries: MemoryEntry[];
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

/**
 * Full ingestion pipeline:
 *   1. Read git commits from the repo
 *   2. Classify each commit into a typed IngestionEvent
 *   3. Deduplicate against the local ingest state file
 *   4. Bundle new events into MemoryEntry records
 *   5. Save to 0G storage (unless dryRun)
 *   6. Update the local ingest state file
 *
 * @param project_id - Project to ingest into
 * @param repoPath   - Absolute path to the git repository (defaults to cwd)
 * @param options    - Ingestion configuration
 * @returns Result summary
 */
export async function runIngestion(
  project_id: string,
  repoPath = process.cwd(),
  options: IngestionOptions = {}
): Promise<IngestionResult> {
  const { since, maxCommits = MAX_COMMITS_DEFAULT, batchSize = 5, dryRun = false } = options;

  // 1. Load dedup state
  const state = loadIngestState(repoPath, project_id);
  const existingFingerprints = new Set(state.ingested_fingerprints);

  // 2. Collect raw commits from git
  const rawCommits = collectGitCommits(repoPath, since, maxCommits);

  // 3. Classify into IngestionEvents
  const allEvents: IngestionEvent[] = rawCommits.map((commit) => {
    const timestamp = new Date(commit.date).getTime() || Date.now();
    return classifyIngestionEvent(
      commit.message,
      commit.changedFiles,
      commit.hash,
      timestamp,
      project_id
    );
  });

  // 4. Deduplicate
  const newEvents = deduplicateEvents(allEvents, existingFingerprints);
  const skipped = allEvents.length - newEvents.length;

  if (newEvents.length === 0) {
    return { saved: 0, skipped, events: allEvents, new_entries: [] };
  }

  // 5. Bundle into MemoryEntry records
  const entries = bundleEventsAsMemoryEntries(newEvents, project_id, batchSize);

  // 6. Save to 0G storage (unless dry run)
  if (!dryRun) {
    for (const entry of entries) {
      await saveMemory(project_id, entry);
    }

    // Update local dedup state
    state.ingested_fingerprints.push(...newEvents.map((e) => e.fingerprint));
    state.last_run_at = Date.now();
    saveIngestState(repoPath, state);
  }

  return {
    saved: entries.length,
    skipped,
    events: allEvents,
    new_entries: entries,
  };
}

/**
 * Checks whether a project already has ingest entries in its memory.
 * Useful for showing a meaningful status in the CLI.
 *
 * @param project_id - Project identifier
 * @returns Count of ingest entries found
 */
export async function countIngestEntries(project_id: string): Promise<number> {
  const entries = await loadAllEntries(project_id);
  return entries.filter((e) =>
    e.tags.some((t) => t.startsWith(INGEST_TAG_PREFIX))
  ).length;
}
