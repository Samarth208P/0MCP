/**
 * Shared utility functions used across all 0MCP modules.
 * Keep this pure — no side effects, no imports from other src/ files.
 */

import { ethers } from "ethers";

// ── Stream ID ─────────────────────────────────────────────────────────────────

/**
 * Derives a deterministic 0G KV stream ID from a project identifier.
 * Same project_id always produces the same stream — stable across restarts.
 * @param project_id - Unique project identifier string
 * @returns Hex-encoded keccak256 hash prefixed with 0x
 */
export function getStreamId(project_id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`0mcp:${project_id}`));
}

// ── Byte encoding ─────────────────────────────────────────────────────────────

/**
 * Encodes a string key to a Uint8Array (UTF-8).
 * @param key - The key string to encode
 */
export function encodeKey(key: string): Uint8Array {
  return Uint8Array.from(Buffer.from(key, "utf-8"));
}

/**
 * Serialises any JSON-compatible value to a Uint8Array.
 * @param value - The value to encode
 */
export function encodeValue(value: unknown): Uint8Array {
  return Uint8Array.from(Buffer.from(JSON.stringify(value), "utf-8"));
}

/**
 * Deserialises a Uint8Array back to a typed value.
 * Returns null if the input is null (key not found in KV store).
 * @param bytes - Raw bytes from KV store, or null
 */
export function decodeValue<T>(bytes: Uint8Array | null): T | null {
  if (!bytes) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf-8")) as T;
}

// ── Async helpers ─────────────────────────────────────────────────────────────

/**
 * Resolves after `ms` milliseconds — use in demo scripts for pacing.
 * @param ms - Milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async function up to `maxRetries` times with exponential backoff.
 * Throws the last error if all attempts fail.
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of attempts (default 3)
 * @param baseDelayMs - Initial delay in ms; doubles each retry (default 500)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

// ── Keyword utilities (shared with context engine) ────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of", "and", "or",
  "but", "not", "with", "this", "that", "was", "are", "be", "have", "has", "do",
  "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "i", "you", "we", "they", "he", "she", "my", "your", "their", "our", "what",
  "how", "why", "when", "where", "which", "who", "please", "help", "make",
  "create", "use", "get", "set", "add", "remove", "update", "fix", "write",
  "give", "me", "from", "into", "about", "like", "just", "also", "need", "want",
]);

/**
 * Extracts meaningful keywords from a text string.
 * Lowercases, strips punctuation, removes stop words, deduplicates.
 * No external API or model needed — deterministic and fast.
 * @param text - Input text to extract keywords from
 * @returns Array of unique, meaningful keyword strings
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);
}
