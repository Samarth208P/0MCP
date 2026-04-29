import { ethers } from "ethers";
import { loadBrain, mintSnapshot, exportSnapshot } from "./snapshot.js";
import { resolveBrain } from "./ens.js";
import type { MemorySnapshot, MemoryEntry, MergeResult } from "./types.js";
import { extractKeywords } from "./utils.js";
import { loadLocalEnv } from "./env.js";

loadLocalEnv();

const MERGE_REGISTRY_ADDRESS = process.env.MERGE_REGISTRY_ADDRESS || "0x0000000000000000000000000000000000000000";
const ZG_RPC_URL = process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai";
const ZG_CHAIN_ID = Number(process.env.ZG_CHAIN_ID || "16602");
const MERGE_REGISTRY_ABI = [
  "function recordMerge(string calldata parentA, string calldata parentB, string calldata syntheticEns, uint256[] calldata newTokenIds, string calldata rootHash) external"
];

function jaccardSimilarity(arr1: string[], arr2: string[]): number {
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export interface MergeOptions {
  criteriaTags?: string[];
  maxEntries?: number;
}

export function mergeSnapshots(
  snapshotA: MemorySnapshot,
  snapshotB: MemorySnapshot,
  options: MergeOptions = {}
): MemorySnapshot {
  const max = options.maxEntries || 200;
  const criteria = options.criteriaTags?.map(t => t.toLowerCase()) || [];

  let combined = [...snapshotA.entries, ...snapshotB.entries];

  // Deduplicate entries by prompt similarity.
  const uniqueEntries: MemoryEntry[] = [];
  for (const entry of combined) {
    const words = entry.prompt.toLowerCase().split(/\s+/);
    let isDuplicate = false;
    for (const u of uniqueEntries) {
      const uWords = u.prompt.toLowerCase().split(/\s+/);
      if (jaccardSimilarity(words, uWords) > 0.8) {
        if (entry.timestamp > u.timestamp) {
          Object.assign(u, entry);
        }
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      uniqueEntries.push(entry);
    }
  }

  uniqueEntries.sort((a, b) => {
    let aScore = 0;
    let bScore = 0;
    
    if (criteria.length > 0) {
      const aTags = [...a.tags, ...extractKeywords(a.prompt + " " + a.response)].map(t => t.toLowerCase());
      const bTags = [...b.tags, ...extractKeywords(b.prompt + " " + b.response)].map(t => t.toLowerCase());
      
      aScore += criteria.filter(c => aTags.includes(c)).length * 10;
      bScore += criteria.filter(c => bTags.includes(c)).length * 10;
    }

    aScore += a.timestamp / 1e12;
    bScore += b.timestamp / 1e12;

    return bScore - aScore;
  });

  const finalEntries = uniqueEntries.slice(0, max);

  const allText = finalEntries
    .map(e => `${e.prompt} ${e.response} ${e.tags.join(" ")}`)
    .join(" ");

  const keywordFreq: Record<string, number> = {};
  extractKeywords(allText).forEach((kw) => {
    keywordFreq[kw] = (keywordFreq[kw] ?? 0) + 1;
  });

  const topKeywords = Object.entries(keywordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([kw]) => kw);

  const filePaths = [...new Set(finalEntries.flatMap(e => e.file_paths))];
  const timestamps = finalEntries.map(e => e.timestamp);

  return {
    version: "1.0",
    project_id: `merged_${snapshotA.project_id}_${snapshotB.project_id}`,
    exported_at: Date.now(),
    entry_count: finalEntries.length,
    entries: finalEntries,
    metadata: {
      top_keywords: topKeywords,
      date_range: {
        first: timestamps.length > 0 ? Math.min(...timestamps) : 0,
        last: timestamps.length > 0 ? Math.max(...timestamps) : 0,
      },
      file_paths: filePaths,
    },
  };
}

import { registerAgent } from "./ens.js";
import { requestBrainMemory } from "./exchange.js";

export async function mergeBrains(
  ensA: string,
  ensB: string,
  outputLabel: string,
  options: MergeOptions = {}
): Promise<MergeResult> {
  console.error(`[merger] Initiating merge: ${ensA} + ${ensB} -> ${outputLabel}.0mcp.eth`);

  const metaA = await resolveBrain(ensA);
  const metaB = await resolveBrain(ensB);

  let snapA: MemorySnapshot;
  try {
     snapA = await loadBrain(ensA);
  } catch(e) {
     console.error(`[merger] Could not load ${ensA} directly. Exporting from the local project instead.`);
     snapA = await exportSnapshot(metaA.project_id);
  }

  let snapB: MemorySnapshot;
  try {
     snapB = await loadBrain(ensB);
  } catch(e) {
     console.error(`[merger] Could not load ${ensB} directly. Requesting it over the AXL mesh...`);
     const sepRpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
     const p = new ethers.JsonRpcProvider(sepRpc);
     const r = await p.getResolver(ensB);
     const peerKey = await r?.getText("com.0mcp.axl.peer");
     if (!peerKey) throw new Error(`Cannot reach ${ensB}: no AXL peer key set on ENS.`);
     
     const fetched = await requestBrainMemory(ensB, peerKey, metaA.project_id) as any;
     snapB = fetched as MemorySnapshot;
  }

  const mergedSnap = mergeSnapshots(snapA, snapB, options);
  console.error(`[merger] Merged into ${mergedSnap.entry_count} entries.`);

  const ownerA = metaA.wallet;
  const ownerB = metaB.wallet;
  const tokenIds: string[] = [];

  const pk = process.env.ZG_PRIVATE_KEY;
  if (!pk) throw new Error("ZG_PRIVATE_KEY missing for minting.");
  let mergeTxHash = "";

  if (ownerA) {
    console.error(`[merger] Minting copy 1 for ${ownerA}...`);
    const res1 = await mintSnapshot(mergedSnap, ownerA);
    tokenIds.push(res1.tokenId);
  }

  if (ownerB && ownerB.toLowerCase() !== ownerA?.toLowerCase()) {
    console.error(`[merger] Minting copy 2 for ${ownerB}...`);
    const res2 = await mintSnapshot(mergedSnap, ownerB);
    tokenIds.push(res2.tokenId);
  }

  const newTokenId = tokenIds.length > 0 ? parseInt(tokenIds[0], 10) : undefined;
  
  const ensName = await registerAgent(mergedSnap.project_id, outputLabel, {
    name: outputLabel,
    description: `Merged from ${ensA} and ${ensB}`,
    project_id: mergedSnap.project_id,
    sessions: mergedSnap.entry_count,
    token_id: newTokenId,
  });

  const wallet = new ethers.Wallet(pk);
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");
  const signer = wallet.connect(provider);
  const resolverAddr = process.env.ENS_RESOLVER_ADDRESS ?? "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
  const resolverContract = new ethers.Contract(resolverAddr, [
    "function setText(bytes32 node, string calldata key, string calldata value) external"
  ], signer);
  const node = ethers.namehash(ensName);
  await resolverContract.setText(node, "com.0mcp.merge.parents", `${ensA},${ensB}`);

  if (MERGE_REGISTRY_ADDRESS !== "0x0000000000000000000000000000000000000000") {
    try {
      const zgProvider = new ethers.JsonRpcProvider(ZG_RPC_URL, ZG_CHAIN_ID);
      const zgSigner = wallet.connect(zgProvider);
      const registry = new ethers.Contract(MERGE_REGISTRY_ADDRESS, MERGE_REGISTRY_ABI, zgSigner);
      const rootHash = "0x";
      const tx = await registry.recordMerge(ensA, ensB, ensName, tokenIds, rootHash);
      await tx.wait();
      console.error(`[merger] Recorded merge on-chain: ${tx.hash}`);
      mergeTxHash = tx.hash;
    } catch(err) {
      console.error(`[merger] Failed to record merge on-chain: ${err}`);
    }
  }

  return {
    synthetic_snapshot: mergedSnap,
    parent_a_ens: ensA,
    parent_b_ens: ensB,
    merge_tx: mergeTxHash,
    token_ids: tokenIds
  };
}
