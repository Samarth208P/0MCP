---
name: 0g-storage
description: Use this skill when writing any code that reads from or writes to 0G decentralized storage — KV store or Log. Triggers when asked to implement saveMemory, loadMemory, listEntries, or anything touching @0gfoundation/0g-ts-sdk, KvClient, Batcher, or the 0G testnet RPC.
---

# 0G Storage Integration — Build Guide

## What This Skill Builds

`src/storage.ts` — the module that reads/writes all project memory to 0G.

Two storage tiers:
- **0G KV** → active memory (fast reads, mutable, per-project)
- **0G Log** → immutable archive (append-only, every interaction forever)

## Install

```bash
npm install @0gfoundation/0g-ts-sdk ethers
```

## Environment Variables (never hardcode these)

```bash
ZG_RPC_URL=https://evmrpc-testnet.0g.ai     # 0G Newton testnet
ZG_KV_NODE=http://3.101.147.150:6789         # Public KV node
ZG_PRIVATE_KEY=0x...                          # Testnet wallet (get from faucet.0g.ai)
ZG_INDEXER_RPC=https://indexer-storage-testnet-standard.0g.ai
```

## Stream ID Strategy

A **Stream ID** is the unique identifier for a KV database. Use one stream per project:

```typescript
import { ethers } from "ethers";

// Deterministic stream ID from project name — same project always gets same stream
export function getStreamId(project_id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`0mcp:${project_id}`));
}
```

## Full Storage Module (src/storage.ts)

```typescript
import { KvClient, Batcher, Indexer } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import type { MemoryEntry } from "./types.js";

const RPC_URL = process.env.ZG_RPC_URL!;
const KV_NODE = process.env.ZG_KV_NODE!;
const INDEXER_RPC = process.env.ZG_INDEXER_RPC!;
const PRIVATE_KEY = process.env.ZG_PRIVATE_KEY!;

// Flow contract on 0G Newton testnet
const FLOW_CONTRACT = "0xbD2C3F0E65eDF5582141C35969d66e34629cC768";

function getStreamId(project_id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`0mcp:${project_id}`));
}

function encodeKey(key: string): Uint8Array {
  return Uint8Array.from(Buffer.from(key, "utf-8"));
}

function encodeValue(value: unknown): Uint8Array {
  return Uint8Array.from(Buffer.from(JSON.stringify(value), "utf-8"));
}

function decodeValue<T>(bytes: Uint8Array | null): T | null {
  if (!bytes) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf-8")) as T;
}

// ── WRITE ──────────────────────────────────────────────────────────────────

export async function saveMemory(
  project_id: string,
  entry: MemoryEntry
): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const indexer = new Indexer(INDEXER_RPC);

  const [nodes, err] = await indexer.selectNodes(1);
  if (err) throw new Error(`Node selection failed: ${err}`);

  const streamId = getStreamId(project_id);
  const entryKey = `entry:${entry.timestamp}`;

  // Write the entry to KV
  const batcher = new Batcher(1, nodes, FLOW_CONTRACT, RPC_URL);
  batcher.streamDataBuilder.set(
    streamId,
    encodeKey(entryKey),
    encodeValue(entry)
  );

  // Also update the index (list of all entry keys for this project)
  const indexKey = "index";
  const existing = await getIndex(project_id);
  existing.push(entryKey);

  // Write index update in same batch
  batcher.streamDataBuilder.set(
    streamId,
    encodeKey(indexKey),
    encodeValue(existing)
  );

  const [tx, batchErr] = await batcher.exec();
  if (batchErr) throw new Error(`Batch write failed: ${batchErr}`);
  console.error(`Memory saved. TX: ${tx}`);
}

// ── READ ───────────────────────────────────────────────────────────────────

export async function loadMemory(
  project_id: string,
  entry_key: string
): Promise<MemoryEntry | null> {
  const kvClient = new KvClient(KV_NODE);
  const streamId = getStreamId(project_id);
  const raw = await kvClient.getValue(
    streamId,
    ethers.encodeBase64(encodeKey(entry_key))
  );
  return decodeValue<MemoryEntry>(raw);
}

export async function getIndex(project_id: string): Promise<string[]> {
  const kvClient = new KvClient(KV_NODE);
  const streamId = getStreamId(project_id);
  const raw = await kvClient.getValue(
    streamId,
    ethers.encodeBase64(encodeKey("index"))
  );
  return decodeValue<string[]>(raw) ?? [];
}

export async function loadAllEntries(
  project_id: string
): Promise<MemoryEntry[]> {
  const keys = await getIndex(project_id);
  const entries = await Promise.all(
    keys.map((key) => loadMemory(project_id, key))
  );
  return entries.filter((e): e is MemoryEntry => e !== null);
}
```

## Common Errors & Fixes

| Error | Cause | Fix |
|---|---|---|
| `Node selection failed` | Indexer unreachable | Check `ZG_INDEXER_RPC` env var |
| `Batch write failed` | No gas / wrong private key | Get testnet tokens from `faucet.0g.ai` |
| `getValue` returns null | Key doesn't exist yet | Return empty array `[]`, don't throw |
| `Cannot find module` | ES module import issue | Ensure `.js` extensions on all imports |

## Getting Testnet Tokens

1. Go to `faucet.0g.ai`
2. Connect your wallet
3. Request testnet OG tokens (free, instant)
4. Use that wallet's private key in `ZG_PRIVATE_KEY`

You need ~0.01 OG per write operation. The faucet gives you enough for hundreds of demo writes.

## Definition of Done

- [ ] `saveMemory` writes a test entry without throwing
- [ ] `loadMemory` retrieves that exact entry back
- [ ] `getIndex` returns correct list of entry keys
- [ ] Works on Newton testnet (not mainnet)
- [ ] No private keys hardcoded anywhere — only in `.env`
