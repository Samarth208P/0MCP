/**
 * 0G Storage Layer — reads and writes project memory on the 0G Galileo testnet.
 *
 * Flow:
 *   1. Upload the full project memory bundle to 0G Storage Turbo via the official indexer
 *   2. Persist the latest bundle root hash in a small on-chain registry contract
 *   3. Read by resolving the bundle root from the registry and downloading the JSON bundle
 *
 * All bundles are encrypted with AES-256-GCM keyed from the user's private key.
 *
 * @module storage
 */

import { Indexer, MemData } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import "./env.js";
import type { MemoryEntry } from "./types.js";
import { getStreamId, withRetry } from "./utils.js";

const RPC_URL = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID ?? "16602");
const DEFAULT_INDEXER_RPC = "https://indexer-storage-testnet-turbo.0g.ai";
const DEFAULT_INDEXER_FALLBACK_RPC = "https://indexer-storage-testnet-standard.0g.ai";
const MEMORY_REGISTRY_ADDRESS = process.env.MEMORY_REGISTRY_ADDRESS ?? "";

const MEMORY_REGISTRY_ABI = [
  "function setProjectRoot(string calldata projectId, string calldata rootHash) external",
  "function getProjectRoot(string calldata projectId) external view returns (string memory)",
];

interface StoredProjectMemory {
  version: "1.0";
  project_id: string;
  updated_at: number;
  entries?: MemoryEntry[];
  encrypted_data?: string;
}

function encryptMemory(data: string, privateKeyHex: string): string {
  const key = crypto.createHash("sha256").update(privateKeyHex).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let ciphertext = cipher.update(data, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${ciphertext}`;
}

function decryptMemory(encrypted: string, privateKeyHex: string): string {
  const key = crypto.createHash("sha256").update(privateKeyHex).digest();
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted data format");

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export interface StorageHealthStatus {
  kvHealthy: boolean;
  indexerHealthy: boolean;
  kvEndpoint?: string;
  indexerEndpoint?: string;
  issues: string[];
}

// Suppress unused import (getStreamId kept for future key-based lookups)
void getStreamId;

function getPrivateKey(): string {
  return process.env.ZG_PRIVATE_KEY ?? "";
}

function parseEndpointList(...values: Array<string | undefined>): string[] {
  return values
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function getIndexerEndpoints(): string[] {
  return parseEndpointList(
    process.env.ZG_INDEXER_RPC ?? DEFAULT_INDEXER_RPC,
    process.env.ZG_INDEXER_FALLBACK_RPC ?? DEFAULT_INDEXER_FALLBACK_RPC
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(RPC_URL, ZG_CHAIN_ID);
}

function getRegistry(runner: ethers.ContractRunner): ethers.Contract {
  if (!MEMORY_REGISTRY_ADDRESS) {
    throw new Error("MEMORY_REGISTRY_ADDRESS is not set in environment.");
  }
  return new ethers.Contract(MEMORY_REGISTRY_ADDRESS, MEMORY_REGISTRY_ABI, runner);
}

async function getWorkingIndexer(): Promise<{ indexer: Indexer; endpoint: string }> {
  const endpoints = getIndexerEndpoints();
  const issues: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const indexer = new Indexer(endpoint);
      await withTimeout(indexer.getShardedNodes(), 6000, `Indexer probe ${endpoint}`);
      return { indexer, endpoint };
    } catch (err) {
      issues.push(`${endpoint} (${formatError(err)})`);
    }
  }

  throw new Error(
    `No healthy 0G indexer endpoint available. Checked: ${issues.join("; ") || "none"}`
  );
}

async function getProjectRoot(project_id: string): Promise<string> {
  const provider = getProvider();
  const registry = getRegistry(provider);
  const rootHash = await withTimeout(
    registry.getProjectRoot(project_id) as Promise<string>,
    8000,
    `Registry lookup ${project_id}`
  );
  return rootHash;
}

async function setProjectRoot(project_id: string, rootHash: string): Promise<void> {
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error("ZG_PRIVATE_KEY is not set in environment.");

  const provider = getProvider();
  const signer = new ethers.Wallet(privateKey, provider);
  const registry = getRegistry(signer);

  const tx = await (registry.setProjectRoot as (
    projectId: string,
    root: string
  ) => Promise<ethers.ContractTransactionResponse>)(project_id, rootHash);

  await tx.wait();
  console.error(`[storage] Registry updated | project=${project_id} | root=${rootHash} | tx=${tx.hash}`);
}

async function uploadProjectBundle(
  project_id: string,
  entries: MemoryEntry[]
): Promise<{ rootHash: string; txHash: string; endpoint: string }> {
  const privateKey = getPrivateKey();
  if (!privateKey) throw new Error("ZG_PRIVATE_KEY is not set in environment.");

  const { indexer, endpoint } = await getWorkingIndexer();
  const provider = getProvider();
  const signer = new ethers.Wallet(privateKey, provider);

  const serializedEntries = JSON.stringify(entries);
  const encrypted_data = encryptMemory(serializedEntries, privateKey);

  const payload: StoredProjectMemory = {
    version: "1.0",
    project_id,
    updated_at: Date.now(),
    encrypted_data,
  };

  const data = new TextEncoder().encode(JSON.stringify(payload));
  const memData = new MemData(data);
  const [, treeErr] = await memData.merkleTree();
  if (treeErr !== null) {
    throw new Error(`Merkle tree error: ${String(treeErr)}`);
  }

  const [tx, uploadErr] = await withRetry(
    () => indexer.upload(memData, RPC_URL, signer as never),
    2,
    1000
  );

  if (uploadErr !== null) {
    throw new Error(`0G upload failed via ${endpoint}: ${String(uploadErr)}`);
  }

  if (!("rootHash" in tx) || !("txHash" in tx)) {
    throw new Error("Unexpected fragmented upload result for project memory bundle.");
  }

  return { rootHash: tx.rootHash, txHash: tx.txHash, endpoint };
}

async function downloadProjectBundle(project_id: string): Promise<StoredProjectMemory | null> {
  const rootHash = await getProjectRoot(project_id);
  if (!rootHash) return null;

  const { indexer, endpoint } = await getWorkingIndexer();
  const tempPath = path.join(
    os.tmpdir(),
    `0mcp-${project_id.replace(/[^a-z0-9_-]/gi, "_")}-${Date.now()}.json`
  );

  try {
    const err = await withRetry(() => indexer.download(rootHash, tempPath, true), 2, 1000);
    if (err !== null) {
      throw new Error(`0G download failed via ${endpoint}: ${String(err)}`);
    }

    const raw = await fs.readFile(tempPath, "utf8");
    const parsed = JSON.parse(raw) as StoredProjectMemory;

    if (parsed.encrypted_data) {
      try {
        const privateKey = getPrivateKey();
        const decryptedStr = decryptMemory(parsed.encrypted_data, privateKey);
        parsed.entries = JSON.parse(decryptedStr);
      } catch (err) {
        console.error(`[storage] Failed to decrypt memory bundle (wrong private key?). err=${String(err)}`);
        parsed.entries = [];
      }
    } else if (!parsed.entries) {
      parsed.entries = [];
    }

    return parsed;
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Checks the health of the 0G storage backend.
 * Verifies: RPC connectivity, indexer availability, on-chain registry responsiveness.
 */
export async function checkStorageHealth(): Promise<StorageHealthStatus> {
  const issues: string[] = [];
  let kvHealthy = false;
  let indexerHealthy = false;
  let kvEndpoint: string | undefined;
  let indexerEndpoint: string | undefined;

  try {
    const provider = getProvider();
    const network = await withTimeout(provider.getNetwork(), 6000, "RPC probe");
    if (Number(network.chainId) !== ZG_CHAIN_ID) {
      issues.push(`RPC chain ID mismatch: expected ${ZG_CHAIN_ID}, got ${network.chainId.toString()}`);
    }
  } catch (err) {
    issues.push(`RPC: ${formatError(err)}`);
  }

  try {
    const { indexer, endpoint } = await getWorkingIndexer();
    indexerHealthy = true;
    indexerEndpoint = endpoint;

    const nodes = await withTimeout(indexer.getShardedNodes(), 6000, "Indexer node list");
    const firstNode = nodes?.trusted?.[0]?.url;
    if (firstNode) kvEndpoint = firstNode;
    kvHealthy = true;
  } catch (err) {
    issues.push(`Indexer: ${formatError(err)}`);
  }

  if (!MEMORY_REGISTRY_ADDRESS) {
    issues.push("Registry: MEMORY_REGISTRY_ADDRESS is not set.");
    kvHealthy = false;
  } else {
    try {
      const provider = getProvider();
      const registry = getRegistry(provider);
      await withTimeout(
        registry.getProjectRoot("__0mcp_healthcheck__") as Promise<string>,
        6000,
        "Registry probe"
      );
    } catch (err) {
      issues.push(`Registry: ${formatError(err)}`);
      kvHealthy = false;
    }
  }

  return {
    kvHealthy,
    indexerHealthy,
    kvEndpoint,
    indexerEndpoint,
    issues,
  };
}

export async function saveMemory(
  project_id: string,
  entry: MemoryEntry
): Promise<{ rootHash: string; txHash: string; endpoint: string }> {
  const entryKey = `entry:${entry.timestamp}`;
  const existingEntries = await loadAllEntries(project_id);
  const nextEntries = [...existingEntries, entry];
  const result = await uploadProjectBundle(project_id, nextEntries);
  await setProjectRoot(project_id, result.rootHash);
  invalidateCache(project_id);
  console.error(
    `[storage] Saved entry=${entryKey} | entries=${nextEntries.length} | root=${result.rootHash} | uploadTx=${result.txHash} | indexer=${result.endpoint}`
  );
  return result;
}

/**
 * Loads a single memory entry by its entry key.
 *
 * @param project_id - Project identifier
 * @param entry_key  - Key in the format "entry:<timestamp>"
 */
export async function loadMemory(
  project_id: string,
  entry_key: string
): Promise<MemoryEntry | null> {
  const timestamp = Number(entry_key.replace(/^entry:/, ""));
  const entries = await loadAllEntries(project_id);
  return entries.find((entry) => entry.timestamp === timestamp) ?? null;
}

/**
 * Returns all entry keys for a project.
 *
 * @param project_id - Project identifier
 */
export async function getIndex(project_id: string): Promise<string[]> {
  const entries = await loadAllEntries(project_id);
  return entries.map((entry) => `entry:${entry.timestamp}`);
}

const memoryCache = new Map<string, { entries: MemoryEntry[]; timestamp: number }>();
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Returns all memory entries for a project from 0G Storage.
 * Returns an empty array if no bundle exists yet.
 * Uses a 1-minute in-memory cache to avoid redundant 0G downloads.
 *
 * @param project_id - Project identifier
 */
export async function loadAllEntries(project_id: string): Promise<MemoryEntry[]> {
  const cached = memoryCache.get(project_id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.entries;
  }

  const bundle = await downloadProjectBundle(project_id);
  const entries = bundle?.entries ?? [];

  memoryCache.set(project_id, { entries, timestamp: Date.now() });
  return entries;
}

/**
 * Invalidates the in-memory cache for a project.
 */
export function invalidateCache(project_id: string): void {
  memoryCache.delete(project_id);
}

