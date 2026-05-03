/**
 * Memory Health Dashboard — report generator and trend tracker.
 *
 * Computes health metrics from stored MemoryEntry records using the
 * analysis layer, formats them for terminal or JSON output, and
 * optionally saves daily snapshots to a local history file.
 *
 * Health snapshots are stored locally at .0mcp-health-history.json.
 * No on-chain cost for metrics history.
 *
 * @module health
 */

import fs from "node:fs";
import path from "node:path";
import { loadAllEntries } from "./storage.js";
import { computeHealthMetrics } from "./analysis.js";
import type { MemoryHealthReport } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const HEALTH_HISTORY_FILE = ".0mcp-health-history.json";
const MAX_HISTORY_SNAPSHOTS = 90; // ~3 months of daily snapshots

// ── History Types ─────────────────────────────────────────────────────────────

interface HealthHistoryFile {
  version: "1.0";
  project_id: string;
  snapshots: MemoryHealthReport[];
}

// ── History Management ────────────────────────────────────────────────────────

function historyFilePath(workDir = process.cwd()): string {
  return path.join(workDir, HEALTH_HISTORY_FILE);
}

/**
 * Appends a health report to the local history file for trend tracking.
 * Bounded to MAX_HISTORY_SNAPSHOTS entries (oldest pruned automatically).
 *
 * @param report  - The report to persist
 * @param workDir - Directory to write the history file (defaults to cwd)
 */
export function saveHealthSnapshot(report: MemoryHealthReport, workDir = process.cwd()): void {
  const filePath = historyFilePath(workDir);
  let history: HealthHistoryFile = {
    version: "1.0",
    project_id: report.project_id,
    snapshots: [],
  };

  if (fs.existsSync(filePath)) {
    try {
      history = JSON.parse(fs.readFileSync(filePath, "utf8")) as HealthHistoryFile;
    } catch {
      // Corrupt — start fresh
    }
  }

  history.snapshots.push(report);

  // Prune old snapshots
  if (history.snapshots.length > MAX_HISTORY_SNAPSHOTS) {
    history.snapshots = history.snapshots.slice(-MAX_HISTORY_SNAPSHOTS);
  }

  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf8");
}

/**
 * Loads historical health snapshots for a project.
 *
 * @param workDir - Directory containing the history file
 * @param limit   - Maximum number of snapshots to return (newest first)
 * @returns Array of MemoryHealthReport, newest first
 */
export function loadHealthHistory(
  workDir = process.cwd(),
  limit = 30
): MemoryHealthReport[] {
  const filePath = historyFilePath(workDir);
  if (!fs.existsSync(filePath)) return [];

  try {
    const history = JSON.parse(fs.readFileSync(filePath, "utf8")) as HealthHistoryFile;
    return history.snapshots.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// ── Report Generator ──────────────────────────────────────────────────────────

/**
 * Generates a full health report for a project by loading all entries
 * and delegating metric computation to the analysis layer.
 *
 * @param project_id - Project identifier
 * @param saveSnapshot - Whether to save this report to the history file (default true)
 * @param workDir      - Working directory for the history file
 * @returns Complete MemoryHealthReport
 */
export async function generateHealthReport(
  project_id: string,
  saveSnapshot = true,
  workDir = process.cwd()
): Promise<MemoryHealthReport> {
  const entries = await loadAllEntries(project_id);
  const report = computeHealthMetrics(entries, project_id);

  if (saveSnapshot) {
    try {
      saveHealthSnapshot(report, workDir);
    } catch {
      // Non-fatal — don't block the report
    }
  }

  return report;
}

// ── Terminal Formatter ────────────────────────────────────────────────────────

interface FormatOptions {
  /** 'full' shows all metrics. 'compact' shows only warnings + key counts. */
  mode?: "full" | "compact";
  /** ANSI colour helpers passed from CLI (avoids importing ANSI in this pure module). */
  colors?: {
    green: (s: string) => string;
    yellow: (s: string) => string;
    red: (s: string) => string;
    cyan: (s: string) => string;
    dim: (s: string) => string;
    bold: (s: string) => string;
    magenta: (s: string) => string;
  };
}

const identity = (s: string) => s;

/**
 * Formats a MemoryHealthReport as a human-readable terminal string.
 *
 * @param report  - Health report to format
 * @param options - Display options (mode, colors)
 * @returns Multi-line string ready for stderr output
 */
export function formatHealthReport(
  report: MemoryHealthReport,
  options: FormatOptions = {}
): string {
  const { mode = "full", colors } = options;
  const c = colors ?? {
    green: identity, yellow: identity, red: identity, cyan: identity,
    dim: identity, bold: identity, magenta: identity,
  };

  const lines: string[] = [];

  const date = new Date(report.generated_at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  lines.push(c.dim(`  Generated: ${date}`));
  lines.push("");

  // ── Key metrics ────────────────────────────────────────────────────────────
  const lastSave = report.last_save_at
    ? new Date(report.last_save_at).toISOString().split("T")[0]
    : c.red("never");

  const daysSinceLastSave = report.last_save_at
    ? Math.floor((Date.now() - report.last_save_at) / (24 * 60 * 60 * 1000))
    : null;

  const lastSaveDisplay = daysSinceLastSave !== null
    ? `${lastSave} ${c.dim(`(${daysSinceLastSave}d ago)`)}`
    : lastSave;

  lines.push(c.bold("  MEMORY METRICS"));
  lines.push(`    Total entries:       ${c.cyan(String(report.total_entries))}`);
  lines.push(`    Real entries:        ${c.cyan(String(report.total_entries - report.ingested_entry_count))}`);
  lines.push(`    Ingested (git):      ${c.dim(String(report.ingested_entry_count))}`);
  lines.push(`    Last saved:          ${lastSaveDisplay}`);
  lines.push(`    Avg entry size:      ${c.dim(report.avg_entry_size_chars + " chars")}`);
  lines.push("");

  if (mode === "full") {
    lines.push(c.bold("  QUALITY METRICS"));

    const tagPct = report.tag_coverage_pct;
    const tagColor = tagPct >= 70 ? c.green : tagPct >= 40 ? c.yellow : c.red;
    lines.push(`    Tag coverage:        ${tagColor(tagPct + "%")} ${c.dim("(entries with ≥1 tag)")}`);

    const filePct = report.file_path_coverage_pct;
    const fileColor = filePct >= 50 ? c.green : filePct >= 25 ? c.yellow : c.red;
    lines.push(`    File-path coverage:  ${fileColor(filePct + "%")} ${c.dim("(entries referencing files)")}`);

    const dupPct = report.duplicate_rate_pct;
    const dupColor = dupPct <= 5 ? c.green : dupPct <= 15 ? c.yellow : c.red;
    lines.push(`    Duplicate rate:      ${dupColor(dupPct + "%")}`);

    const staleColor = report.stale_entry_count === 0 ? c.green : c.yellow;
    lines.push(`    Stale entries:       ${staleColor(String(report.stale_entry_count))} ${c.dim("(>30 days old)")}`);

    const contColor = report.contradiction_count === 0 ? c.green
      : report.contradiction_count <= 5 ? c.yellow : c.red;
    lines.push(`    Contradictions:      ${contColor(String(report.contradiction_count))}`);
    lines.push("");
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  if (report.warnings.length > 0) {
    lines.push(c.bold(c.yellow("  WARNINGS")));
    for (const w of report.warnings) {
      lines.push(`    ${c.yellow("⚠")} ${w}`);
    }
    lines.push("");
  }

  // ── Recommendations ───────────────────────────────────────────────────────
  if (report.recommendations.length > 0) {
    lines.push(c.bold("  RECOMMENDATIONS"));
    for (const r of report.recommendations) {
      lines.push(`    ${c.cyan("→")} ${r}`);
    }
    lines.push("");
  }

  // ── All-clear ─────────────────────────────────────────────────────────────
  if (report.warnings.length === 0 && report.total_entries > 0) {
    lines.push(`    ${c.green("✓")} Memory is healthy. No issues detected.`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Trend Formatter ───────────────────────────────────────────────────────────

/**
 * Formats a compact trend view from the last N health snapshots.
 *
 * @param snapshots - Recent snapshots (newest first)
 * @param colors    - ANSI colour helpers
 * @returns Multi-line trend string
 */
export function formatHealthTrend(
  snapshots: MemoryHealthReport[],
  colors?: FormatOptions["colors"]
): string {
  const c = colors ?? {
    green: identity, yellow: identity, red: identity, cyan: identity,
    dim: identity, bold: identity, magenta: identity,
  };

  if (snapshots.length === 0) {
    return "  No health history found. Run `0mcp memory health` to create the first snapshot.\n";
  }

  const lines: string[] = [c.bold("  HEALTH TREND (last 7 snapshots)"), ""];

  const recent = snapshots.slice(0, 7).reverse(); // oldest → newest for trend display

  const header = "  Date".padEnd(16) + "Entries".padEnd(10) + "Tags%".padEnd(9) +
    "Files%".padEnd(9) + "Contradictions".padEnd(16) + "Warnings";
  lines.push(c.dim(header));
  lines.push(c.dim("  " + "─".repeat(68)));

  for (const snap of recent) {
    const date = new Date(snap.generated_at).toISOString().split("T")[0];
    const row = [
      ("  " + date).padEnd(16),
      String(snap.total_entries).padEnd(10),
      (snap.tag_coverage_pct + "%").padEnd(9),
      (snap.file_path_coverage_pct + "%").padEnd(9),
      String(snap.contradiction_count).padEnd(16),
      snap.warnings.length > 0 ? c.yellow(String(snap.warnings.length)) : c.green("0"),
    ].join("");
    lines.push(row);
  }

  lines.push("");
  return lines.join("\n");
}
