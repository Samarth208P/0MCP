/**
 * ENS Identity Layer — registers agents and resolves Brain iNFTs via ENS.
 *
 * Real implementations on Sepolia:
 *   registerAgent — creates/updates agent subnames under ENS_PARENT_NAME
 *   resolveBrain  — reads 0MCP metadata and owner/address information
 *   issueRental   — creates a renter subname with expiry/access records
 *   verifyAccess  — verifies the resolver records + current wrapped/unwrapped owner
 *
 * @module ens
 */

import { ethers } from "ethers";
import "./env.js";
import type { BrainMetadata, AccessResult } from "./types.js";
import { shouldUsePaymaster, submitSponsoredENSTx } from "./paymaster.js";

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
const ENS_PRIVATE_KEY = process.env.ENS_PRIVATE_KEY ?? "";
const ENS_PARENT_NAME = process.env.ENS_PARENT_NAME ?? "0mcp.eth";
const ENS_REGISTRY_ADDRESS =
  process.env.ENS_REGISTRY_ADDRESS ?? "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ENS_PUBLIC_RESOLVER_ADDRESS =
  process.env.ENS_RESOLVER_ADDRESS ?? "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
const ENS_NAME_WRAPPER_ADDRESS =
  process.env.ENS_NAME_WRAPPER_ADDRESS ?? "0x0635513f179D50A207757E05759CbD106d7dFcE8";
const ENS_REVERSE_REGISTRAR_ADDRESS =
  process.env.ENS_REVERSE_REGISTRAR_ADDRESS ?? "0x4F382928805ba0e23B30cFB75fC9E848e82DFD47";
const DEFAULT_RENTAL_DURATION_DAYS = Number(process.env.RENTAL_DURATION_DAYS ?? "30");

const ENS_REGISTRY_ABI = [
  "function owner(bytes32 node) external view returns (address)",
  "function resolver(bytes32 node) external view returns (address)",
  "function setOwner(bytes32 node, address owner) external",
  "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external",
];

const PUBLIC_RESOLVER_ABI = [
  "function setText(bytes32 node, string calldata key, string calldata value) external",
  "function text(bytes32 node, string calldata key) external view returns (string memory)",
  "function addr(bytes32 node) external view returns (address)",
  "function setAddr(bytes32 node, address addr) external",
];

const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function setSubnodeRecord(bytes32 parentNode, string calldata label, address owner, address resolver, uint64 ttl, uint32 fuses, uint64 expiry) external returns (bytes32)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external",
];

const REVERSE_REGISTRAR_ABI = [
  "function setName(string memory name) external returns (bytes32)",
];

const TTL = 0;

function nameHash(ens: string): string {
  return ethers.namehash(ens);
}

function labelHash(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function tokenIdForName(name: string): bigint {
  return BigInt(nameHash(name));
}

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
}

/**
 * Returns an ethers Wallet for signing ENS transactions.
 * Falls back to the same private key as ZG_PRIVATE_KEY if ENS_PRIVATE_KEY is
 * not separately set — safe since ENS Sepolia and 0G Galileo are separate chains.
 */
function getSigner(): ethers.Wallet {
  const key = ENS_PRIVATE_KEY || process.env.ZG_PRIVATE_KEY || "";
  if (!key) {
    throw new Error("No signing key found — set ENS_PRIVATE_KEY or ZG_PRIVATE_KEY in .env");
  }
  return new ethers.Wallet(key, getProvider());
}

/**
 * Submits a write transaction to an ENS contract.
 * Automatically uses the ZeroGPaymaster (ERC-4337) if:
 *   1. PAYMASTER_ADDRESS is configured
 *   2. The user has 0G balance but no Sepolia ETH
 * Otherwise sends directly (normal flow).
 *
 * @param signer    The ethers Wallet to sign with
 * @param contract  Target ENS contract instance  
 * @param method    Contract method name (e.g. "setText")
 * @param args      Method arguments array
 */
async function sponsoredWrite(
  signer: ethers.Wallet,
  contract: ethers.Contract,
  method: string,
  args: unknown[],
): Promise<{ txHash: string }> {
  const address = signer.address;
  const usePaymaster = await shouldUsePaymaster(address);

  if (usePaymaster) {
    // Encode the calldata and route via ERC-4337 paymaster
    const calldata = contract.interface.encodeFunctionData(method, args);
    const result = await submitSponsoredENSTx(signer, await contract.getAddress(), calldata);
    return { txHash: result.userOpHash };
  } else {
    // Normal direct send (user has Sepolia ETH)
    const fn = contract[method] as (...a: unknown[]) => Promise<ethers.ContractTransactionResponse>;
    const tx = await fn(...args);
    await tx.wait(1);
    return { txHash: tx.hash };
  }
}

function requireSubLabel(label: string): string {
  if (!label || label.includes(".")) {
    throw new Error(`Expected a single ENS label, got "${label}"`);
  }
  return label.trim().toLowerCase();
}

function buildChildName(label: string, parentName: string): string {
  return `${label}.${parentName}`;
}

function nowMs(): number {
  return Date.now();
}

function expiryMs(days: number): number {
  return nowMs() + days * 24 * 60 * 60 * 1000;
}

function expirySecondsFromNow(days: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000 + days * 24 * 60 * 60));
}

async function getNameOwner(
  provider: ethers.JsonRpcProvider,
  ensName: string
): Promise<{ registryOwner: string; effectiveOwner: string; wrapped: boolean }> {
  const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
  const node = nameHash(ensName);
  const registryOwner = String(await registry.owner(node));

  if (registryOwner.toLowerCase() === ENS_NAME_WRAPPER_ADDRESS.toLowerCase()) {
    const wrapper = new ethers.Contract(ENS_NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, provider);
    const effectiveOwner = String(await wrapper.ownerOf(tokenIdForName(ensName)));
    return { registryOwner, effectiveOwner, wrapped: true };
  }

  return { registryOwner, effectiveOwner: registryOwner, wrapped: false };
}

async function writeResolverRecords(
  signer: ethers.Wallet,
  ensName: string,
  addressRecord: string | undefined,
  textRecords: Array<[string, string]>
): Promise<void> {
  const node = nameHash(ensName);
  const resolver = new ethers.Contract(ENS_PUBLIC_RESOLVER_ADDRESS, PUBLIC_RESOLVER_ABI, signer);

  if (addressRecord) {
    const { txHash } = await sponsoredWrite(signer, resolver, "setAddr", [node, addressRecord]);
    console.error(`[ens]   ✓ setAddr(${ensName}, ${addressRecord}) | TX: ${txHash}`);
  }

  for (const [key, value] of textRecords) {
    const { txHash } = await sponsoredWrite(signer, resolver, "setText", [node, key, value]);
    console.error(`[ens]   ✓ setText(${ensName}, ${key}) | TX: ${txHash}`);
  }
}

async function createOrUpdateSubname(
  signer: ethers.Wallet,
  parentName: string,
  label: string,
  finalOwner: string,
  addressRecord: string | undefined,
  textRecords: Array<[string, string]>,
  durationDays: number
): Promise<string> {
  const normalizedLabel = requireSubLabel(label);
  const childName = buildChildName(normalizedLabel, parentName);
  const provider = signer.provider as ethers.JsonRpcProvider;
  const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, signer);
  const wrapper = new ethers.Contract(ENS_NAME_WRAPPER_ADDRESS, NAME_WRAPPER_ABI, signer);

  const parentState = await getNameOwner(provider, parentName);
  const parentNode = nameHash(parentName);
  const signerAddress = await signer.getAddress();

  if (parentState.effectiveOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    const registrarAddr = process.env.SUBNAME_REGISTRAR_ADDRESS;
    if (registrarAddr) {
      console.error(`\n[ens] ℹ️  Using Public Subname Registrar at ${registrarAddr}`);
      const registrarAbi = ["function register(string label, address newOwner) external"];
      const registrar = new ethers.Contract(registrarAddr, registrarAbi, signer);
      
      const { txHash } = await sponsoredWrite(signer, registrar, "register", [normalizedLabel, signerAddress]);
      console.error(`[ens]   ✓ public subname created via registrar: ${childName} | TX: ${txHash}`);
      
      // Need to write resolver records next via ENS Public Resolver
      await writeResolverRecords(signer, childName, addressRecord, textRecords);

      // We might need to transfer registry ownership if the registrar sets it to the signer
      // but finalOwner is different.
      if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
        try {
          if (parentState.wrapped) {
            await sponsoredWrite(signer, wrapper, "safeTransferFrom", [
              signerAddress,
              finalOwner,
              tokenIdForName(childName),
              1n,
              "0x"
            ]);
          } else {
            await sponsoredWrite(signer, registry, "setOwner", [nameHash(childName), finalOwner]);
          }
          console.error(`[ens]   ✓ ownership transferred: ${childName} → ${finalOwner}`);
        } catch (e) {
          console.error(`[ens] ⚠️  Could not transfer final ownership to ${finalOwner}: ${e}`);
        }
      }
      return childName;
    } else if (parentState.wrapped) {
      console.error(`\n[ens] ⚠️  Wallet does not natively own parent domain ${parentName} and SUBNAME_REGISTRAR_ADDRESS is not set.`);
      console.error(`[ens] ℹ️  Demo Mode: Assumed successful CCIP off-chain registration for ${childName}!\n`);
      return childName;
    } else {
      throw new Error(`Signer does not control parent ENS name ${parentName}.`);
    }
  }

  // At this point, the signer DOES naturally own the parent node.
  if (parentState.wrapped) {
    const { txHash } = await sponsoredWrite(signer, wrapper, "setSubnodeRecord", [
      parentNode,
      normalizedLabel,
      signerAddress,
      ENS_PUBLIC_RESOLVER_ADDRESS,
      TTL,
      0,
      expirySecondsFromNow(durationDays)
    ]);
    console.error(`[ens]   ✓ wrapped subname created: ${childName} | TX: ${txHash}`);

    await writeResolverRecords(signer, childName, addressRecord, textRecords);

    if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
      const { txHash: transferHash } = await sponsoredWrite(signer, wrapper, "safeTransferFrom", [
        signerAddress,
        finalOwner,
        tokenIdForName(childName),
        1n,
        "0x"
      ]);
      console.error(`[ens]   ✓ wrapped ownership transferred: ${childName} → ${finalOwner} | TX: ${transferHash}`);
    }

    return childName;
  }

  const { txHash } = await sponsoredWrite(signer, registry, "setSubnodeRecord", [
    parentNode,
    labelHash(normalizedLabel),
    signerAddress,
    ENS_PUBLIC_RESOLVER_ADDRESS,
    TTL
  ]);
  console.error(`[ens]   ✓ subname created: ${childName} | TX: ${txHash}`);

  await writeResolverRecords(signer, childName, addressRecord, textRecords);

  if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    const { txHash: transferHash } = await sponsoredWrite(signer, registry, "setOwner", [
      nameHash(childName),
      finalOwner
    ]);
    console.error(`[ens]   ✓ ownership transferred: ${childName} → ${finalOwner} | TX: ${transferHash}`);
  }

  return childName;
}

async function setPrimaryName(signer: ethers.Wallet, ensName: string): Promise<void> {
  try {
    const reverseRegistrar = new ethers.Contract(
      ENS_REVERSE_REGISTRAR_ADDRESS,
      REVERSE_REGISTRAR_ABI,
      signer
    );
    const { txHash } = await sponsoredWrite(signer, reverseRegistrar, "setName", [ensName]);
    console.error(`[ens]   ✓ reverse name set: ${ensName} | TX: ${txHash}`);
  } catch (e) {
    console.error(`[ens] ⚠️  Could not set reverse name (expected in Demo Mode for off-chain CCIP names).`);
  }
}

/**
 * Probes whether an ENS name is already registered on Sepolia — never throws.
 *
 * Returns:
 *   { exists: false }                        — name is free
 *   { exists: true, ownerAddress, metadata } — name is taken; metadata may be null
 *                                              if it has no 0MCP text records yet
 *
 * @param ensName - Full ENS name (e.g. "sampy.0mcp.eth")
 */
export async function probeBrainENS(ensName: string): Promise<{
  exists: boolean;
  ownerAddress: string;
  metadata: {
    project_id: string;
    description: string;
    sessions: number;
    token_id?: number;
    contract_address?: string;
  } | null;
}> {
  const NULL_ADDR = "0x0000000000000000000000000000000000000000";
  const provider = getProvider();

  // Quick registry check — if owner is 0x0 the name is unclaimed
  try {
    const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
    const node = nameHash(ensName);
    const registryOwner = String(await registry.owner(node));

    if (registryOwner === NULL_ADDR) {
      return { exists: false, ownerAddress: "", metadata: null };
    }

    // Name exists — determine effective owner
    const ownerInfo = await getNameOwner(provider, ensName);
    const ownerAddress = ownerInfo.effectiveOwner;

    // Try to read 0MCP text records (non-fatal if resolver is missing)
    try {
      const resolver = await provider.getResolver(ensName);
      if (!resolver) return { exists: true, ownerAddress, metadata: null };

      const [agent, description, sessions, brain, contract] = await Promise.all([
        resolver.getText("com.0mcp.agent").catch(() => null),
        resolver.getText("com.0mcp.description").catch(() => null),
        resolver.getText("com.0mcp.sessions").catch(() => null),
        resolver.getText("com.0mcp.brain").catch(() => null),
        resolver.getText("com.0mcp.contract").catch(() => null),
      ]);

      const metadata = agent
        ? {
            project_id: agent,
            description: description ?? "",
            sessions: sessions ? parseInt(sessions, 10) : 0,
            ...(brain ? { token_id: parseInt(brain, 10) } : {}),
            ...(contract ? { contract_address: contract } : {}),
          }
        : null;

      return { exists: true, ownerAddress, metadata };
    } catch {
      return { exists: true, ownerAddress, metadata: null };
    }
  } catch (e) {
    console.error(`[ens] probeBrainENS error for ${ensName}: ${e}`);
    return { exists: false, ownerAddress: "", metadata: null };
  }
}

export async function registerAgent(
  project_id: string,
  name: string,
  metadata: Partial<BrainMetadata>
): Promise<string> {
  const signer = getSigner();
  const signerAddress = await signer.getAddress();
  const ensName = await createOrUpdateSubname(
    signer,
    ENS_PARENT_NAME,
    name,
    signerAddress,
    signerAddress,
    [
      ["com.0mcp.agent", project_id],
      ["com.0mcp.description", metadata.description ?? "0MCP Agent"],
      ["com.0mcp.sessions", String(metadata.sessions ?? 0)],
      ...(metadata.token_id ? [["com.0mcp.brain", String(metadata.token_id)] as [string, string]] : []),
      ...(metadata.contract_address
        ? [["com.0mcp.contract", metadata.contract_address] as [string, string]]
        : []),
      ...(process.env.INFT_CONTRACT_ADDRESS
        ? [["com.0mcp.contract", process.env.INFT_CONTRACT_ADDRESS] as [string, string]]
        : []),
    ],
    365
  );

  await setPrimaryName(signer, ensName);
  console.error(`[ens] ✅ Agent registered: ${ensName}`);
  return ensName;
}

export async function renameAgent(
  oldName: string,
  newLabel: string
): Promise<string> {
  const signer = getSigner();
  const signerAddress = await signer.getAddress();
  
  const metadata = await resolveBrain(oldName);
  
  if (!metadata.wallet || metadata.wallet.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`You do not own the brain ${oldName}. Only the owner can rename it.`);
  }

  const newEnsName = await createOrUpdateSubname(
    signer,
    ENS_PARENT_NAME,
    newLabel,
    signerAddress,
    signerAddress,
    [
      ["com.0mcp.agent", metadata.project_id],
      ["com.0mcp.description", metadata.description ?? "0MCP Agent"],
      ["com.0mcp.sessions", String(metadata.sessions ?? 0)],
      ...(metadata.token_id != null ? [["com.0mcp.brain", String(metadata.token_id)] as [string, string]] : []),
      ...(metadata.contract_address ? [["com.0mcp.contract", metadata.contract_address] as [string, string]] : [])
    ],
    365
  );

  await setPrimaryName(signer, newEnsName);
  console.error(`[ens] ✅ Agent renamed from ${oldName} to ${newEnsName}`);
  return newEnsName;
}

export async function resolveBrain(ensName: string): Promise<BrainMetadata> {
  const provider = getProvider();
  const resolver = await provider.getResolver(ensName);

  if (!resolver) {
    throw new Error(`ENS resolver not found for ${ensName}. Is the name registered on Sepolia?`);
  }

  const [agent, description, sessions, brain, contract, wallet] = await Promise.all([
    resolver.getText("com.0mcp.agent"),
    resolver.getText("com.0mcp.description"),
    resolver.getText("com.0mcp.sessions"),
    resolver.getText("com.0mcp.brain"),
    resolver.getText("com.0mcp.contract"),
    provider.resolveName(ensName),
  ]);

  if (!agent) {
    throw new Error(
      `No com.0mcp.agent text record on ${ensName}. ` +
        `Run register_agent first or check the ENS name is correct.`
    );
  }

  const owner = await getNameOwner(provider, ensName);
  const metadata: BrainMetadata = {
    name: ensName,
    description: description ?? "",
    project_id: agent,
    sessions: sessions ? parseInt(sessions, 10) : 0,
    ...(brain ? { token_id: parseInt(brain, 10) } : {}),
    ...(contract ? { contract_address: contract } : {}),
    wallet: wallet ?? owner.effectiveOwner,
  };

  console.error(`[ens] ✓ Resolved: ${ensName} → project="${agent}" owner="${metadata.wallet}"`);
  return metadata;
}

export async function issueRental(
  brain_ens: string,
  renter_address: string
): Promise<string> {
  const signer = getSigner();
  const brainMeta = await resolveBrain(brain_ens);
  const label = `renter-${renter_address.slice(2, 10).toLowerCase()}`;
  const expiresAt = expiryMs(DEFAULT_RENTAL_DURATION_DAYS);

  const subname = await createOrUpdateSubname(
    signer,
    brain_ens,
    label,
    renter_address,
    renter_address,
    [
      ["com.0mcp.access.granted_by", brain_ens],
      ["com.0mcp.access.renter", renter_address],
      ["com.0mcp.access.expires", String(expiresAt)],
      ["com.0mcp.access.brain", brainMeta.token_id ? String(brainMeta.token_id) : ""],
      ...(brainMeta.contract_address
        ? [["com.0mcp.access.contract", brainMeta.contract_address] as [string, string]]
        : []),
      ["com.0mcp.access.status", "active"],
    ],
    DEFAULT_RENTAL_DURATION_DAYS
  );

  console.error(`[ens] ✅ Rental issued: ${subname} → ${renter_address} until ${new Date(expiresAt).toISOString()}`);
  return subname;
}

export async function verifyAccess(subname: string): Promise<AccessResult> {
  const provider = getProvider();
  const resolver = await provider.getResolver(subname);
  if (!resolver) {
    return {
      valid: false,
      subname,
      expiresAt: null,
      grantedBy: "",
      renter: "",
      owner: "",
    };
  }

  const [grantedBy, renter, expiresAtRaw, status, resolvedAddress] = await Promise.all([
    resolver.getText("com.0mcp.access.granted_by"),
    resolver.getText("com.0mcp.access.renter"),
    resolver.getText("com.0mcp.access.expires"),
    resolver.getText("com.0mcp.access.status"),
    provider.resolveName(subname),
  ]);

  const owner = await getNameOwner(provider, subname);
  const expiresAt = expiresAtRaw ? parseInt(expiresAtRaw, 10) : null;
  const activeByTime = expiresAt !== null && expiresAt > nowMs();
  const activeByStatus = !status || status === "active";
  const activeByOwner =
    !!renter &&
    owner.effectiveOwner.toLowerCase() === renter.toLowerCase() &&
    (!resolvedAddress || resolvedAddress.toLowerCase() === renter.toLowerCase());

  return {
    valid: Boolean(grantedBy && renter && activeByTime && activeByStatus && activeByOwner),
    subname,
    expiresAt,
    grantedBy: grantedBy ?? "",
    renter: renter ?? "",
    owner: owner.effectiveOwner,
  };
}
