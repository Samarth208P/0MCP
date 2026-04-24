/**
 * Shared TypeScript interfaces for 0MCP.
 * All modules import from here — single source of truth.
 */

// ── Core memory types ─────────────────────────────────────────────────────────

/** A single logged interaction between a user and their AI agent. */
export interface MemoryEntry {
  /** Project identifier — all entries for a project share this id. */
  project_id: string;
  /** The user's original prompt. */
  prompt: string;
  /** The AI agent's response. */
  response: string;
  /** File paths referenced in this interaction. */
  file_paths: string[];
  /** User-supplied or auto-extracted tags/keywords. */
  tags: string[];
  /** Unix millisecond timestamp of when this entry was saved. */
  timestamp: number;
}

/** Result metadata returned alongside retrieved context. */
export interface ContextResult {
  entries: MemoryEntry[];
  total_found: number;
  injected: number;
}

// ── Snapshot / iNFT types ─────────────────────────────────────────────────────

/** Portable memory bundle exported for iNFT minting or sharing. */
export interface MemorySnapshot {
  version: "1.0";
  project_id: string;
  /** Unix ms timestamp of when this snapshot was created. */
  exported_at: number;
  entry_count: number;
  entries: MemoryEntry[];
  metadata: {
    /** Top 20 most frequent keywords across all entries. */
    top_keywords: string[];
    date_range: {
      first: number;
      last: number;
    };
    /** All unique file paths referenced across all entries. */
    file_paths: string[];
  };
}

/** Result of minting a Brain iNFT. */
export interface MintResult {
  tokenId: string;
  txHash: string;
  ensName?: string;
}

// ── ENS types ────────────────────────────────────────────────────────────────

/** Resolved metadata for an ENS-registered Brain agent. */
export interface BrainMetadata {
  wallet: string;
  tokenId: string;
  name: string;
  description: string;
  project_id: string;
  sessions: number;
}

/** Result of ENS rental access verification. */
export interface AccessResult {
  valid: boolean;
  expiresAt: number | null;
}

// ── KeeperHub types ───────────────────────────────────────────────────────────

/** Result of an on-chain execution routed through KeeperHub. */
export interface ExecResult {
  txHash: string;
  gasUsed: string;
}
