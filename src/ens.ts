/**
 * ENS identity layer — agent registration, brain discovery, rental access tokens.
 * register_agent + resolve_brain: real implementations on Sepolia.
 * issue_rental + verify_access: stubs (NameWrapper complexity, roadmap).
 * @module ens
 */

import type { BrainMetadata, AccessResult } from "./types.js";

// STUB — implemented in Phase 5
export async function registerAgent(
  _projectId: string,
  _name: string,
  _metadata: Partial<BrainMetadata>
): Promise<string> {
  throw new Error("ens: not implemented yet — Phase 5");
}

export async function resolveBrain(_ensName: string): Promise<BrainMetadata> {
  throw new Error("ens: not implemented yet — Phase 5");
}

// STUB (roadmap — NameWrapper required for subname issuance)
export async function issueRental(
  _brainEns: string,
  _renterAddr: string
): Promise<string> {
  // STUB: roadmap item — requires ENS NameWrapper contract
  throw new Error("ens: not implemented yet — Phase 5");
}

export async function verifyAccess(_subname: string): Promise<AccessResult> {
  // STUB: roadmap item — requires ENS NameWrapper contract
  throw new Error("ens: not implemented yet — Phase 5");
}
