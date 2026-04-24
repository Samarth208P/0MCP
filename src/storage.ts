/**
 * 0G Storage layer — reads and writes project memory to 0G Newton testnet.
 * Implements two-tier storage: KV (active memory) + fallback mock mode.
 * @module storage
 */

// STUB — implemented in Phase 2
export async function saveMemory(_project_id: string, _entry: unknown): Promise<void> {
  throw new Error("storage: not implemented yet — Phase 2");
}

export async function loadMemory(_project_id: string, _key: string): Promise<null> {
  throw new Error("storage: not implemented yet — Phase 2");
}

export async function getIndex(_project_id: string): Promise<string[]> {
  throw new Error("storage: not implemented yet — Phase 2");
}

export async function loadAllEntries(_project_id: string): Promise<never[]> {
  throw new Error("storage: not implemented yet — Phase 2");
}
