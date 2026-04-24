/**
 * KeeperHub integration — routes agent-suggested on-chain actions.
 * Endpoint: https://app.keeperhub.com/mcp
 * Auth: Bearer kh_ API key
 * Full implementation on testnet (Phase 7).
 * @module keeper
 */

import type { ExecResult } from "./types.js";

// STUB — implemented in Phase 7
export async function execOnchain(
  _target: string,
  _calldata: string,
  _value?: string
): Promise<ExecResult> {
  throw new Error("keeper: not implemented yet — Phase 7");
}
