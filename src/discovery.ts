import { ethers } from "ethers";
import "./env.js";
import { resolveBrain } from "./ens.js";
import type { BrainMetadata } from "./types.js";

const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DEFAULT_PARENT_NAME = "0mcp.eth";
const DEFAULT_REGISTRAR_ADDRESS = "0xA2C96740159b7a47541DEfF991aD5edfa671661d";
const DEFAULT_LOG_CHUNK = 50000;
const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_BLOCKS_PER_DAY = 7200;

const REGISTRAR_ABI = [
  "event SubnameRegistered(string label, address owner)",
];
const REGISTRAR_IFACE = new ethers.Interface(REGISTRAR_ABI);

export interface MeshDiscoveryPeer {
  ens_name: string;
  label: string;
  owner_address: string;
  project_id: string;
  description: string;
  sessions: number;
  token_id?: number;
  contract_address?: string;
  wallet?: string;
  axl_peer_key: string;
  price_og: string;
  expertise: string[];
  last_seen: number;
}

export interface MeshDiscoveryOptions {
  keyword?: string;
  limit?: number;
  parentName?: string;
  registrarAddress?: string;
  startBlock?: number;
}

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC);
}

function getParentName(options?: MeshDiscoveryOptions): string {
  return options?.parentName ?? process.env.ENS_PARENT_NAME ?? DEFAULT_PARENT_NAME;
}

function getRegistrarAddress(options?: MeshDiscoveryOptions): string {
  return options?.registrarAddress ?? process.env.SUBNAME_REGISTRAR_ADDRESS ?? DEFAULT_REGISTRAR_ADDRESS;
}

function parseCsv(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getKeywordMatcher(keyword?: string): (peer: MeshDiscoveryPeer) => boolean {
  if (!keyword?.trim()) {
    return () => true;
  }

  const needle = keyword.trim().toLowerCase();
  return (peer: MeshDiscoveryPeer) => {
    const haystack = [
      peer.ens_name,
      peer.label,
      peer.owner_address,
      peer.project_id,
      peer.description,
      peer.axl_peer_key,
      peer.price_og,
      String(peer.sessions),
      String(peer.token_id ?? ""),
      peer.contract_address ?? "",
      ...(peer.expertise ?? []),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(needle);
  };
}

async function hydratePeer(
  ensName: string,
  provider: ethers.JsonRpcProvider
): Promise<MeshDiscoveryPeer | null> {
  const meta: BrainMetadata = await resolveBrain(ensName);
  const resolver = await provider.getResolver(ensName);
  if (!resolver) return null;

  const [axlPeerKey, priceRaw, expertiseRaw] = await Promise.all([
    resolver.getText("com.0mcp.axl.peer").catch(() => null),
    resolver.getText("com.0mcp.axl.price").catch(() => null),
    resolver.getText("com.0mcp.axl.expertise").catch(() => null),
  ]);

  if (!axlPeerKey) return null;

  return {
    ens_name: meta.name,
    label: meta.name.split(".")[0] ?? meta.name,
    owner_address: meta.wallet ?? "",
    project_id: meta.project_id,
    description: meta.description,
    sessions: meta.sessions,
    token_id: meta.token_id,
    contract_address: meta.contract_address,
    wallet: meta.wallet,
    axl_peer_key: axlPeerKey,
    price_og: priceRaw || "0",
    expertise: parseCsv(expertiseRaw),
    last_seen: Date.now(),
  };
}

/**
 * Discovers peers by scanning the 0MCP registrar event log, then hydrating the
 * corresponding ENS records. This gives us a real peer index that can be
 * filtered by keyword and extended by simply registering through the registrar.
 */
export async function discoverMeshPeers(options: MeshDiscoveryOptions = {}): Promise<MeshDiscoveryPeer[]> {
  const registrarAddress = getRegistrarAddress(options);
  if (!registrarAddress) {
    throw new Error("SUBNAME_REGISTRAR_ADDRESS is not set. Mesh discovery needs the registrar-backed peer index.");
  }

  const provider = getProvider();
  const parentName = getParentName(options);
  const endBlock = await provider.getBlockNumber();
  const keywordMatches = getKeywordMatcher(options.keyword);
  const limit = options.limit && options.limit > 0 ? options.limit : 20;
  const chunkSize = Number(process.env.DISCOVERY_LOG_CHUNK ?? `${DEFAULT_LOG_CHUNK}`);
  const startOverride = process.env.DISCOVERY_START_BLOCK?.trim();
  const explicitStart = options.startBlock ?? (startOverride ? Number(startOverride) : NaN);
  const configuredStart = Number.isFinite(explicitStart) ? Math.max(0, Math.floor(explicitStart)) : null;
  const lookbackDays = Number(process.env.DISCOVERY_LOOKBACK_DAYS ?? `${DEFAULT_LOOKBACK_DAYS}`);
  const blocksPerDay = Number(process.env.DISCOVERY_BLOCKS_PER_DAY ?? `${DEFAULT_BLOCKS_PER_DAY}`);
  const lookbackBlocks = Math.max(1, Math.floor(Math.max(1, lookbackDays) * Math.max(1, blocksPerDay)));
  const startBlock = configuredStart ?? Math.max(0, endBlock - lookbackBlocks);
  const seen = new Set<string>();
  const peers: MeshDiscoveryPeer[] = [];
  const topic0 = REGISTRAR_IFACE.getEvent("SubnameRegistered")?.topicHash;
  if (!topic0) {
    throw new Error("Unable to derive SubnameRegistered event topic.");
  }

  outer: for (let toBlock = endBlock; toBlock >= startBlock; toBlock -= chunkSize) {
    const fromBlock = Math.max(startBlock, toBlock - chunkSize + 1);
    const logs = await provider.getLogs({
      address: registrarAddress,
      fromBlock,
      toBlock,
      topics: [topic0],
    });

    for (let i = logs.length - 1; i >= 0; i--) {
      const parsed = REGISTRAR_IFACE.parseLog(logs[i]);
      const label = String(parsed?.args?.label ?? "").trim();
      if (!label) continue;

      const ensName = `${label}.${parentName}`;
      if (seen.has(ensName)) continue;
      seen.add(ensName);

      try {
        const peer = await hydratePeer(ensName, provider);
        if (!peer) continue;
        if (!keywordMatches(peer)) continue;
        peers.push(peer);
        if (peers.length >= limit) {
          break outer;
        }
      } catch {
        // Skip names that no longer resolve or are missing the expected records.
      }
    }
  }

  const localBrain = (process.env.BRAIN_ENS_NAME ?? "").trim();
  if (localBrain && !seen.has(localBrain)) {
    seen.add(localBrain);
    try {
      const peer = await hydratePeer(localBrain, provider);
      if (peer && keywordMatches(peer)) {
        peers.push(peer);
      }
    } catch {
      // Ignore local fallback errors.
    }
  }

  peers.sort((a, b) => {
    if (b.sessions !== a.sessions) return b.sessions - a.sessions;
    return a.ens_name.localeCompare(b.ens_name);
  });

  return peers.slice(0, limit);
}
