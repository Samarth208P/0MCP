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
import { TxLogger } from "./txlogger.js";
import { withRetry } from "./utils.js";

const getSepoliaRpcUrl = () => process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const getEnsPrivateKey = () => process.env.ENS_PRIVATE_KEY ?? "";
const getEnsParentName = () => process.env.ENS_PARENT_NAME ?? "0mcp.eth";
const getEnsRegistryAddress = () =>
  process.env.ENS_REGISTRY_ADDRESS ?? "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const getEnsResolverAddress = () =>
  process.env.ENS_RESOLVER_ADDRESS ?? "0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5";
const getEnsNameWrapperAddress = () =>
  process.env.ENS_NAME_WRAPPER_ADDRESS ?? "0x0635513f179D50A207757E05759CbD106d7dFcE8";
const getEnsReverseRegistrarAddress = () =>
  process.env.ENS_REVERSE_REGISTRAR_ADDRESS ?? "0x4F382928805ba0e23B30cFB75fC9E848e82DFD47";
const getRentalDurationDays = () => Number(process.env.RENTAL_DURATION_DAYS ?? "30");

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
  const req = new ethers.FetchRequest(getSepoliaRpcUrl());
  req.timeout = 60000;
  return new ethers.JsonRpcProvider(req, 11155111, { staticNetwork: true as never });
}

function getSigner(): ethers.Wallet | null {
  const key = getEnsPrivateKey() || process.env.ZG_PRIVATE_KEY || "";
  if (!key) return null;
  return new ethers.Wallet(key, getProvider());
}

/**
 * Submits a write transaction to an ENS contract.
 *
 * Priority order:
 *   1. Paymaster  — when PAYMASTER_ADDRESS is set and user has no Sepolia ETH (gas-free via 0G)
 *   2. Direct     — fallback when user has Sepolia ETH
 *
 * All paths record the TX via TxLogger so users see every receipt.
 */
async function sponsoredWrite(
  signer: ethers.Wallet | null,
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  label?: string,   // human-readable label for TxLogger (defaults to method name)
): Promise<{ txHash: string }> {
  return withRetry(
    () => _sponsoredWriteInternal(signer, contract, method, args, label),
    3,
    5000
  );
}

async function _sponsoredWriteInternal(
  signer: ethers.Wallet | null,
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  label?: string,
): Promise<{ txHash: string }> {
  if (!signer) {
    throw new Error("Private key missing. Signer required for on-chain writes.");
  }

  const address = signer.address;
  const targetAddress = await contract.getAddress();
  const calldata = contract.interface.encodeFunctionData(method, args);
  const txLabel = label ?? method;

  // ── 1. ERC-4337 Paymaster ─────────────────────────────────────────────────
  const usePaymaster = await shouldUsePaymaster(address);
  if (usePaymaster) {
    console.error(`[ens] Using ERC-4337 paymaster for: ${txLabel}`);
    const result = await submitSponsoredENSTx(signer, targetAddress, calldata);
    TxLogger.record({
      chain:  "sepolia",
      label:  txLabel,
      txHash: result.userOpHash,
      via:    "paymaster",
    });
    return { txHash: result.userOpHash };
  }

  // ── 3. Direct transaction ─────────────────────────────────────────────────
  console.error(`[ens] Direct send (Sepolia ETH): ${txLabel}`);
  const fn = contract[method] as (...a: unknown[]) => Promise<ethers.ContractTransactionResponse>;
  const tx = await fn(...args);
  await tx.wait(1);
  TxLogger.record({
    chain:  "sepolia",
    label:  txLabel,
    txHash: tx.hash,
    via:    "direct",
  });
  return { txHash: tx.hash };
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
  const registry = new ethers.Contract(getEnsRegistryAddress(), ENS_REGISTRY_ABI, provider);
  const node = nameHash(ensName);
  const registryOwner = String(await registry.owner(node));

  if (registryOwner.toLowerCase() === getEnsNameWrapperAddress().toLowerCase()) {
    const wrapper = new ethers.Contract(getEnsNameWrapperAddress(), NAME_WRAPPER_ABI, provider);
    const effectiveOwner = String(await wrapper.ownerOf(tokenIdForName(ensName)));
    return { registryOwner, effectiveOwner, wrapped: true };
  }

  return { registryOwner, effectiveOwner: registryOwner, wrapped: false };
}

async function writeResolverRecords(
  signer: ethers.Wallet | null,
  ensName: string,
  addressRecord: string | undefined,
  textRecords: Array<[string, string]>
): Promise<void> {
  const node = nameHash(ensName);
  const provider = signer?.provider ?? getProvider();
  const resolver = new ethers.Contract(getEnsResolverAddress(), PUBLIC_RESOLVER_ABI, signer ?? provider);

  if (addressRecord) {
    await sponsoredWrite(signer, resolver, "setAddr", [node, addressRecord], `setAddr(${ensName})`);
  }

  for (const [key, value] of textRecords) {
    // Truncate value for log readability (private key never appears — values are metadata)
    const shortVal = value.length > 40 ? `${value.slice(0, 37)}…` : value;
    await sponsoredWrite(
      signer, resolver, "setText", [node, key, value],
      `setText(${key}=${shortVal})`
    );
  }
}

async function createOrUpdateSubname(
  signer: ethers.Wallet | null,
  parentName: string,
  label: string,
  finalOwner: string,
  addressRecord: string | undefined,
  textRecords: Array<[string, string]>,
  durationDays: number
): Promise<string> {
  const normalizedLabel = requireSubLabel(label);
  const childName = buildChildName(normalizedLabel, parentName);
  const provider = signer?.provider ?? getProvider();
  const registry = new ethers.Contract(getEnsRegistryAddress(), ENS_REGISTRY_ABI, signer ?? provider);
  const wrapper = new ethers.Contract(getEnsNameWrapperAddress(), NAME_WRAPPER_ABI, signer ?? provider);

  const parentState = await getNameOwner(provider as ethers.JsonRpcProvider, parentName);
  const parentNode = nameHash(parentName);
  if (!signer) {
     throw new Error(`Signer required to register ${childName}.`);
  }
  const signerAddress = await signer.getAddress();
  if (parentState.effectiveOwner.toLowerCase() !== signerAddress.toLowerCase()) {
      const registrarAddr = process.env.SUBNAME_REGISTRAR_ADDRESS ?? "0xA2C96740159b7a47541DEfF991aD5edfa671661d";
    if (registrarAddr) {
      console.error(`\n[ens] Using Public Subname Registrar at ${registrarAddr}`);
      const registrarAbi = ["function register(string label, address newOwner) external"];
      const registrar = new ethers.Contract(registrarAddr, registrarAbi, signer);

      await sponsoredWrite(
        signer, registrar, "register", [normalizedLabel, signerAddress],
        `register(${childName})`
      );

      await writeResolverRecords(signer, childName, addressRecord, textRecords);

      if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
        try {
          if (parentState.wrapped) {
            await sponsoredWrite(
              signer, wrapper, "safeTransferFrom",
              [signerAddress, finalOwner, tokenIdForName(childName), 1n, "0x"],
              `transfer(${childName} → ${finalOwner.slice(0, 10)}…)`
            );
          } else {
            await sponsoredWrite(
              signer, registry, "setOwner", [nameHash(childName), finalOwner],
              `setOwner(${childName})`
            );
          }
        } catch (e) {
          console.error(`[ens] ⚠️  Could not transfer ownership to ${finalOwner}: ${e}`);
        }
      }
      return childName;
    } else if (parentState.wrapped) {
      console.error(`[ens] ⚠️  No SUBNAME_REGISTRAR_ADDRESS — assuming CCIP off-chain registration`);
      return childName;
    } else {
      throw new Error(`Signer does not control parent ENS name ${parentName}. Set SUBNAME_REGISTRAR_ADDRESS or use your own ENS parent.`);
    }
  }

  if (parentState.wrapped) {
    await sponsoredWrite(
      signer, wrapper, "setSubnodeRecord",
      [parentNode, normalizedLabel, signerAddress, getEnsResolverAddress(), TTL, 0, expirySecondsFromNow(durationDays)],
      `setSubnodeRecord(${childName})`
    );
    await writeResolverRecords(signer, childName, addressRecord, textRecords);

    if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
      await sponsoredWrite(
        signer, wrapper, "safeTransferFrom",
        [signerAddress, finalOwner, tokenIdForName(childName), 1n, "0x"],
        `transfer(${childName} → ${finalOwner.slice(0, 10)}…)`
      );
    }
    return childName;
  }

  await sponsoredWrite(
    signer, registry, "setSubnodeRecord",
    [parentNode, labelHash(normalizedLabel), signerAddress, getEnsResolverAddress(), TTL],
    `setSubnodeRecord(${childName})`
  );
  await writeResolverRecords(signer, childName, addressRecord, textRecords);

  if (finalOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    await sponsoredWrite(
      signer, registry, "setOwner", [nameHash(childName), finalOwner],
      `setOwner(${childName})`
    );
  }

  return childName;
}

async function setPrimaryName(signer: ethers.Wallet | null, ensName: string): Promise<void> {
  if (!signer) return; 
  try {
    const reverseRegistrar = new ethers.Contract(
      getEnsReverseRegistrarAddress(),
      REVERSE_REGISTRAR_ABI,
      signer
    );
    await sponsoredWrite(signer, reverseRegistrar, "setName", [ensName], `setName(${ensName})`);
  } catch (e) {
    console.error(`[ens] ⚠️  Could not set reverse name (expected for off-chain CCIP names): ${e}`);
  }
}

/**
 * Probes whether an ENS name is already registered on Sepolia — never throws.
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

  try {
    const registry = new ethers.Contract(getEnsRegistryAddress(), ENS_REGISTRY_ABI, provider);
    const node = nameHash(ensName);
    const registryOwner = String(await registry.owner(node));

    if (registryOwner === NULL_ADDR) {
      return { exists: false, ownerAddress: "", metadata: null };
    }

    const ownerInfo = await getNameOwner(provider, ensName);
    const ownerAddress = ownerInfo.effectiveOwner;

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

const getInftContractAddress = () =>
  process.env.INFT_CONTRACT_ADDRESS ?? "0xd07059e54017BbF424223cb089ffBC5e2558cF56";

export async function registerAgent(
  project_id: string,
  name: string,
  metadata: Partial<BrainMetadata>
): Promise<string> {
  const signer = getSigner();
  if (!signer) throw new Error("Private key missing (ENS_PRIVATE_KEY or ZG_PRIVATE_KEY).");
  const signerAddress = await signer.getAddress();
  
  const ensName = await createOrUpdateSubname(
    signer,
    getEnsParentName(),
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
      ...(getInftContractAddress()
        ? [["com.0mcp.contract", getInftContractAddress()] as [string, string]]
        : []),
    ],
    365
  );

  await setPrimaryName(signer, ensName);
  console.error(`[ens] ✅ Agent registered: ${ensName}`);
  return ensName;
}

export async function lookupPrimaryBrain(address: string): Promise<string | null> {
  try {
    const provider = getProvider();
    const name = await provider.lookupAddress(address);
    if (name && name.endsWith(`.${getEnsParentName()}`)) {
      return name;
    }
    return null;
  } catch {
    return null;
  }
}

export async function renameAgent(oldName: string, newLabel: string): Promise<string> {
  const signer = getSigner();
  if (!signer) {
    throw new Error("Private key required to rename Brain (signer not found).");
  }
  const signerAddress = await signer.getAddress();

  const metadata = await resolveBrain(oldName);

  if (!metadata.wallet || metadata.wallet.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(`You do not own the brain ${oldName}. Only the owner can rename it.`);
  }

  const newEnsName = await createOrUpdateSubname(
    signer,
    getEnsParentName(),
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
    throw new Error(
      `ENS resolver not found for ${ensName}. ` +
      `Is the name registered on Sepolia? Run: 0mcp ens register <project-id> <label>`
    );
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
      `Run: 0mcp ens register <project-id> <label>`
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

  return metadata;
}

export async function issueRental(
  brain_ens: string,
  renter_address: string,
  durationDays?: number,
  paymentTx?: string
): Promise<string> {
  const signer = getSigner();
  const brainMeta = await resolveBrain(brain_ens);
  const label = `renter-${renter_address.slice(2, 10).toLowerCase()}`;
  const days = durationDays || getRentalDurationDays();
  const expiresAt = expiryMs(days);

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
      ["com.0mcp.access.duration_days", String(days)],
      ...(paymentTx ? [["com.0mcp.access.payment", paymentTx] as [string, string]] : []),
    ],
    days
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
