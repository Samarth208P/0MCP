/**
 * iNFT snapshot — export project memory and mint as ERC-7857 Brain iNFT.
 * Also handles loading external Brain iNFTs into context.
 * @module snapshot
 */

import type { MemorySnapshot, MintResult } from "./types.js";

// STUB — implemented in Phase 4
export async function exportSnapshot(_project_id: string): Promise<MemorySnapshot> {
  throw new Error("snapshot: not implemented yet — Phase 4");
}

export async function mintSnapshot(
  _snapshot: MemorySnapshot,
  _recipientAddress: string
): Promise<MintResult> {
  throw new Error("snapshot: not implemented yet — Phase 4");
}

export async function loadBrain(_ensName: string): Promise<MemorySnapshot> {
  throw new Error("snapshot: not implemented yet — Phase 4");
}
