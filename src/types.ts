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
  /** The ENS name itself (e.g. solidity-auditor.0mcp.eth) */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Internal project identifier (com.0mcp.agent text record). */
  project_id: string;
  /** Number of memory sessions saved. */
  sessions: number;
  /** Brain iNFT token ID (com.0mcp.brain text record). Optional until minted. */
  token_id?: number;
  /** SimpleINFT contract address (com.0mcp.contract text record). */
  contract_address?: string;
  /** Resolved owner wallet address. */
  wallet?: string;
}

/** Result of ENS rental access verification. */
export interface AccessResult {
  valid: boolean;
  subname: string;
  expiresAt: number | null;
  /** Parent brain ENS name that granted the rental. */
  grantedBy: string;
  /** Wallet the rental subname points to. */
  renter: string;
  /** Current effective ENS owner of the subname. */
  owner: string;
}

// ── TX Logger types ──────────────────────────────────────────────────────────

/** Result of an on-chain execution recorded in logs. */
export interface ExecResult {
  txHash: string;
  gasUsed?: string;
}

// ── AXL Mesh message types ────────────────────────────────────────────────────

export type AXLMessageType =
  | "brain_request"
  | "brain_offer"
  | "brain_delivery"
  | "brain_ack"
  | "merge_proposal"
  | "merge_accept"
  | "discovery_ping"
  | "discovery_pong";

export interface AXLEnvelope {
  type: AXLMessageType;
  from_ens: string;
  from_peer: string;
  timestamp: number;
  nonce: string;
  payload: Record<string, unknown>;
  signature: string;
}

export interface BrainRequestPayload {
  requested_ens: string;
  escrow_tx: string;
  buyer_ens: string;
  buyer_encryption_pubkey: string;
  keywords?: string[];
}

export interface BrainDeliveryPayload {
  encrypted_snapshot: string;
  root_hash: string;
  entry_count: number;
  seller_ens: string;
}

export interface MeshPeer {
  ens_name: string;
  axl_peer_key: string;
  expertise: string[];
  price_og: string;
  last_seen: number;
}

export interface MergeResult {
  synthetic_snapshot: MemorySnapshot;
  parent_a_ens: string;
  parent_b_ens: string;
  merge_tx: string;
  token_ids: string[];
}

// ── Payment / Escrow types ────────────────────────────────────────────────────

export interface EscrowState {
  escrow_id: string;
  buyer: string;
  seller: string;
  amount_wei: string;
  status: "locked" | "released" | "refunded";
  locked_at: number;
  released_at?: number;
}

// ── Analysis / Drift Detection types ─────────────────────────────────────────

/** A normalized decision rule extracted from a MemoryEntry. */
export interface DecisionRule {
  /** sha256 of (project_id + rule_text) — stable dedup key. */
  id: string;
  project_id: string;
  /** Normalized, lowercase rule text for comparison. */
  rule_text: string;
  /** Semantic category of the rule. */
  rule_type:
    | "must"
    | "avoid"
    | "use"
    | "architecture"
    | "contract"
    | "convention"
    | "generic";
  /** Files this rule applies to (inherited from source entry). */
  file_paths: string[];
  tags: string[];
  /** Timestamp of the originating MemoryEntry. */
  source_entry_timestamp: number;
  /** Heuristic confidence score (0–1). Only rules ≥ 0.7 are surfaced. */
  confidence: number;
}

/** A contradiction or drift finding between a new prompt and existing rules. */
export interface DriftFinding {
  severity: "warning" | "info";
  conflicting_rule: DecisionRule;
  /** Short human-readable explanation (≤ 120 chars). */
  conflict_reason: string;
  /** Excerpt from the triggering prompt (≤ 80 chars). */
  prompt_excerpt: string;
}

// ── Ingestion types ───────────────────────────────────────────────────────────

/** A single event ingested from repository activity. */
export interface IngestionEvent {
  event_type:
    | "commit"
    | "file_change"
    | "test_failure"
    | "dependency_update"
    | "architecture_change"
    | "bug_fix"
    | "refactor"
    | "breaking_change"
    | "operational_note";
  source: "git" | "filesystem" | "build_log";
  /**
   * Commit hash or file content hash — used for deduplication.
   * Events with a fingerprint already in the ingest state are skipped.
   */
  fingerprint: string;
  summary: string;
  file_paths: string[];
  timestamp: number;
  raw_metadata?: Record<string, unknown>;
}

// ── Health report types ───────────────────────────────────────────────────────

/** Aggregated memory health report for a project. */
export interface MemoryHealthReport {
  generated_at: number;
  project_id: string;
  total_entries: number;
  /** Unix ms of the most recent entry, or null if no entries. */
  last_save_at: number | null;
  avg_entry_size_chars: number;
  /** Entries older than STALE_THRESHOLD_DAYS (default 30). */
  stale_entry_count: number;
  /** Number of detected contradictions across all rules. */
  contradiction_count: number;
  /** Percentage of non-ingest entries that have ≥ 1 meaningful tag. */
  tag_coverage_pct: number;
  /** Percentage of non-ingest entries that reference ≥ 1 file path. */
  file_path_coverage_pct: number;
  /** Percentage of entries sharing an identical prompt fingerprint. */
  duplicate_rate_pct: number;
  /** Count of entries tagged with __ingest__ prefix. */
  ingested_entry_count: number;
  /** Human-readable advisories (problems found). */
  warnings: string[];
  /** Actionable improvement suggestions. */
  recommendations: string[];
}
