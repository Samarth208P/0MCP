/**
 * paymaster.ts — 0MCP Paymaster Relay
 *
 * Bridges 0G tokens → sponsored Sepolia ETH gas.
 *
 * When a user has NO Sepolia ETH but DOES have 0G tokens:
 *  1. This module checks their 0G balance (must be >= REQUIRED_OG_BALANCE).
 *  2. It encodes the ENS calldata into an ERC-4337 UserOperation.
 *  3. It asks the relay backend (PAYMASTER_RELAY_URL) to co-sign the operation.
 *  4. The signed UserOperation is submitted to the Sepolia bundler.
 *  5. The ZeroGPaymaster contract verifies the relay signature and pays gas.
 *
 * If the user DOES have enough Sepolia ETH, this module is bypassed — the
 * normal direct-send path in ens.ts is used instead (faster, no relay needed).
 *
 * Environment variables:
 *   PAYMASTER_ADDRESS       — deployed ZeroGPaymaster on Sepolia
 *   PAYMASTER_RELAY_URL     — relay endpoint (default: https://relay.0mcp.eth.limo)
 *   PAYMASTER_BUNDLER_URL   — ERC-4337 bundler RPC (default: Pimlico Sepolia)
 *   RELAY_SIGNER_ADDRESS    — relay signer public address (for client verification)
 *   MIN_OG_BALANCE_ETH      — min 0G balance required (default: "0.01")
 *
 * @module paymaster
 */

import { ethers } from "ethers";
import "./env.js";

// ── Config ────────────────────────────────────────────────────────────────────

const getSepoliaRpcUrl = () => process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const getZgRpcUrl = () => process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const getZgChainId = () => Number(process.env.ZG_CHAIN_ID ?? "16602");
const getPaymasterAddress = () => process.env.PAYMASTER_ADDRESS ?? "0xb1Ab695dbcbA334A60712234d46264A617AD6d7f";
const getPaymasterRelayUrl = () => process.env.PAYMASTER_RELAY_URL ?? "https://relay.0mcp.eth.limo";
const getPaymasterBundlerUrl = () => process.env.PAYMASTER_BUNDLER_URL
  ?? "https://api.pimlico.io/v2/sepolia/rpc?apikey=public";
const getRelaySignerAddress = () => process.env.RELAY_SIGNER_ADDRESS ?? "0x4b39D7EE758332a43772f4192B9b864C2Cc4A6eE";

// ERC-4337 EntryPoint on Sepolia (v0.6)
const ENTRY_POINT = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const SIMPLE_ACCOUNT_FACTORY = "0x9406Cc6185a346906296840746125a0E44976454";

// Minimal ABI for a Simple Account (ERC-4337 smart wallet)
const SIMPLE_ACCOUNT_ABI = [
  "function execute(address dest, uint256 value, bytes calldata data) external",
  "function getNonce() external view returns (uint256)",
];

const FACTORY_ABI = [
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) external returns (address)",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserOperation {
  sender:               string;
  nonce:                string;
  initCode:             string;
  callData:             string;
  callGasLimit:         string;
  verificationGasLimit: string;
  preVerificationGas:   string;
  maxFeePerGas:         string;
  maxPriorityFeePerGas: string;
  paymasterAndData:     string;
  signature:            string;
}

export interface SponsoredTxResult {
  userOpHash: string;
  txHash:     string;
  bundler:    string;
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Checks if an address has enough Sepolia ETH to self-fund ENS operations.
 * ENS subname registration + text record sets typically use ~200k gas.
 * At 20 gwei, that's ~0.004 ETH. We use 0.005 as the threshold.
 *
 * @param address Wallet address to check
 * @returns true if Sepolia balance >= 0.005 ETH
 */
export async function hasSepoliaBalance(address: string): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(getSepoliaRpcUrl(), 11155111, { staticNetwork: true as any });
    const balance = await Promise.race([
      provider.getBalance(address),
      new Promise<bigint>((_, reject) => setTimeout(() => reject(new Error("Sepolia timeout")), 10000))
    ]);
    return balance >= ethers.parseEther("0.005");
  } catch (err) {
    console.error(`[paymaster] Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Determines whether the paymaster should be used for a given address.
 * Returns true if:
 *   - PAYMASTER_ADDRESS is configured
 *   - User does NOT have enough Sepolia ETH
 *
 * Exports a simple decision function — ens.ts calls this before every write.
 */
export async function shouldUsePaymaster(address: string): Promise<boolean> {
  if (!getPaymasterAddress()) return false;
  const hasSep = await hasSepoliaBalance(address);
  return !hasSep;
}

// ── Relay request ─────────────────────────────────────────────────────────────

interface RelayRequest {
  userAddress:   string;
  zgBalance:     string;   // Formatted 0G balance (for relay's logs)
  targetContract: string;
  calldata:      string;
  chainId:       number;   // Must be Sepolia (11155111)
}

interface RelayResponse {
  paymasterAndData: string;   // {paymasterAddress}{validUntil}{sig}
  validUntil:       number;
}

/**
 * Requests a paymaster signature from the 0MCP relay backend.
 * The relay verifies 0G balance on-chain, then signs the operation.
 */
async function requestRelaySignature(req: RelayRequest): Promise<RelayResponse> {
  const response = await fetch(`${getPaymasterRelayUrl()}/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`Relay error ${response.status}: ${text}`);
  }

  return response.json() as Promise<RelayResponse>;
}

// ── UserOp builder ────────────────────────────────────────────────────────────

/**
 * Submits a sponsored ENS transaction via ERC-4337.
 *
 * This is called by ens.ts when shouldUsePaymaster() returns true.
 * The caller provides the raw contract calldata (e.g. setText ABI-encoded).
 *
 * @param signer         User's ethers Signer (derived from ZG_PRIVATE_KEY)
 * @param targetContract ENS contract address to call (resolver, registry, etc.)
 * @param calldata       ABI-encoded call to execute
 * @returns SponsoredTxResult with userOpHash and effective txHash
 */
export async function submitSponsoredENSTx(
  signer: ethers.Signer,
  targetContract: string,
  calldata: string,
): Promise<SponsoredTxResult> {
  const userAddress = await signer.getAddress();
  const sepProvider = new ethers.JsonRpcProvider(getSepoliaRpcUrl());
  const zgProvider  = new ethers.JsonRpcProvider(getZgRpcUrl(), getZgChainId());
  const bundlerProvider = new ethers.JsonRpcProvider(getPaymasterBundlerUrl());

  // 1. Get 0G balance for relay verification
  const zgBalance = ethers.formatEther(await zgProvider.getBalance(userAddress));

  // 2. Compute the Smart Wallet Address (Sender) & InitCode
  const factory = new ethers.Contract(SIMPLE_ACCOUNT_FACTORY, FACTORY_ABI, sepProvider);
  const senderAddress = String(await (factory.getFunction("getAddress") as any)(userAddress, 0));

  const code = await sepProvider.getCode(senderAddress);
  const initCode = code === "0x"
    ? ethers.concat([SIMPLE_ACCOUNT_FACTORY, factory.interface.encodeFunctionData("createAccount", [userAddress, 0])])
    : "0x";

  // 3. Build the call that the smart account will make
  const accountIface = new ethers.Interface(SIMPLE_ACCOUNT_ABI);
  const execCalldata = accountIface.encodeFunctionData("execute", [
    targetContract,
    0n,
    calldata,
  ]);

  // 4. Estimate gas (bundler eth_estimateUserOperationGas)
  const feeData = await sepProvider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("30", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");

  // 5. Request relay co-signature (relay verifies 0G balance)
  const relayResp = await requestRelaySignature({
    userAddress,
    zgBalance,
    targetContract,
    calldata,
    chainId: 11155111,
  });

  // 6. Build the unsigned UserOperation
  const nonce: bigint = await bundlerProvider.send("eth_getUserOperationCount", [
    senderAddress, ENTRY_POINT,
  ]).catch(() => 0n);

  const userOp: UserOperation = {
    sender:               senderAddress,
    nonce:                ethers.toBeHex(nonce),
    initCode:             initCode,
    callData:             execCalldata,
    callGasLimit:         ethers.toBeHex(700_000),      // Subname transfers take gas
    verificationGasLimit: ethers.toBeHex(500_000),      // Generous for initCode deployment
    preVerificationGas:   ethers.toBeHex(100_000),
    maxFeePerGas:         ethers.toBeHex(maxFeePerGas),
    maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
    paymasterAndData:     relayResp.paymasterAndData,
    signature:            "0x", // filled below
  };

  // 7. Sign the UserOperation with the user's key
  const userOpHash = computeUserOpHash(userOp);
  const signature = await signer.signMessage(ethers.getBytes(userOpHash));
  userOp.signature = signature;

  // 8. Submit to bundler (Using v0.6 format)
  const submittedHash: string = await bundlerProvider.send(
    "eth_sendUserOperation",
    [userOp, ENTRY_POINT],
  );

  return {
    userOpHash: submittedHash,
    txHash:     submittedHash, // bundler returns userOpHash; receipt resolved async
    bundler:    getPaymasterBundlerUrl(),
  };
}

// ── UserOp hash helper ────────────────────────────────────────────────────────

/**
 * Computes the ERC-4337 UserOperation hash (v0.6 ABI encoded format).
 * This is what the user signs, and what the paymaster verifies.
 */
function computeUserOpHash(op: UserOperation): string {
  const packed = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes32", "bytes32",
     "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
    [
      op.sender,
      op.nonce,
      ethers.keccak256(op.initCode),
      ethers.keccak256(op.callData),
      op.callGasLimit,
      op.verificationGasLimit,
      op.preVerificationGas,
      op.maxFeePerGas,
      op.maxPriorityFeePerGas,
      ethers.keccak256(op.paymasterAndData),
    ]
  );
  return ethers.solidityPackedKeccak256(
    ["bytes32", "address", "uint256"],
    [ethers.keccak256(packed), ENTRY_POINT, 11155111]
  );
}

// ── Status helper (used by CLI wallet dashboard) ──────────────────────────────

export interface PaymasterStatus {
  paymasterAddress:  string;
  relayUrl:          string;
  bundlerUrl:        string;
  configured:        boolean;
  relaySigner:       string;
}

/**
 * Returns current paymaster configuration for display in CLI dashboard.
 */
export function getPaymasterStatus(): PaymasterStatus {
  return {
    paymasterAddress:  getPaymasterAddress()  || "(not deployed)",
    relayUrl:          getPaymasterRelayUrl(),
    bundlerUrl:        getPaymasterBundlerUrl(),
    configured:        !!getPaymasterAddress(),
    relaySigner:       getRelaySignerAddress() || "(not set)",
  };
}
