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

const SEPOLIA_RPC_URL       = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
const ZG_RPC_URL            = process.env.ZG_RPC_URL    ?? "https://evmrpc-testnet.0g.ai";
const ZG_CHAIN_ID           = Number(process.env.ZG_CHAIN_ID ?? "16602");
const PAYMASTER_ADDRESS     = process.env.PAYMASTER_ADDRESS ?? "";
const PAYMASTER_RELAY_URL   = process.env.PAYMASTER_RELAY_URL ?? "https://relay.0mcp.eth.limo";
const PAYMASTER_BUNDLER_URL = process.env.PAYMASTER_BUNDLER_URL
  ?? "https://api.pimlico.io/v2/sepolia/rpc?apikey=public";
const RELAY_SIGNER_ADDRESS  = process.env.RELAY_SIGNER_ADDRESS ?? "";
const MIN_OG_BALANCE_ETH    = process.env.MIN_OG_BALANCE_ETH ?? "0.01";

// ERC-4337 EntryPoint on Sepolia (canonical v0.7)
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// Minimal ABI for a Simple Account (ERC-4337 smart wallet)
const SIMPLE_ACCOUNT_ABI = [
  "function execute(address dest, uint256 value, bytes calldata data) external",
  "function getNonce() external view returns (uint256)",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserOperation {
  sender:               string;
  nonce:                string;
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
 * Checks if the user's 0G balance meets the minimum required.
 * We use 0G balance as a Sybil-resistance signal — ensures only real users
 * can get gas sponsorship.
 *
 * @param address  User's wallet address (same key on 0G and Sepolia)
 * @returns true if balance >= MIN_OG_BALANCE_ETH
 */
export async function has0GBalance(address: string): Promise<boolean> {
  try {
    const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, ZG_CHAIN_ID);
    const balance  = await provider.getBalance(address);
    const required = ethers.parseEther(MIN_OG_BALANCE_ETH);
    return balance >= required;
  } catch {
    return false;
  }
}

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
    const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
    const balance  = await provider.getBalance(address);
    return balance >= ethers.parseEther("0.005");
  } catch {
    return false;
  }
}

/**
 * Determines whether the paymaster should be used for a given address.
 * Returns true if:
 *   - PAYMASTER_ADDRESS is configured
 *   - User has 0G balance (Sybil check)
 *   - User does NOT have enough Sepolia ETH
 *
 * Exports a simple decision function — ens.ts calls this before every write.
 */
export async function shouldUsePaymaster(address: string): Promise<boolean> {
  if (!PAYMASTER_ADDRESS) return false;
  const [hasOG, hasSep] = await Promise.all([
    has0GBalance(address),
    hasSepoliaBalance(address),
  ]);
  return hasOG && !hasSep;
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
  const response = await fetch(`${PAYMASTER_RELAY_URL}/sign`, {
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
  const sepProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const zgProvider  = new ethers.JsonRpcProvider(ZG_RPC_URL, ZG_CHAIN_ID);
  const bundlerProvider = new ethers.JsonRpcProvider(PAYMASTER_BUNDLER_URL);

  // 1. Get 0G balance for relay verification
  const zgBalance = ethers.formatEther(await zgProvider.getBalance(userAddress));

  // 2. Build the call that the smart account will make
  //    (Simple Account: execute(dest, value, data))
  const accountIface = new ethers.Interface(SIMPLE_ACCOUNT_ABI);
  const execCalldata = accountIface.encodeFunctionData("execute", [
    targetContract,
    0n,
    calldata,
  ]);

  // 3. Estimate gas (bundler eth_estimateUserOperationGas)
  const feeData = await sepProvider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("30", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("2", "gwei");

  // 4. Request relay co-signature (relay verifies 0G balance)
  const relayResp = await requestRelaySignature({
    userAddress,
    zgBalance,
    targetContract,
    calldata,
    chainId: 11155111,
  });

  // 5. Build the unsigned UserOperation (nonce from bundler)
  const nonce: bigint = await bundlerProvider.send("eth_getUserOperationCount", [
    userAddress, ENTRY_POINT,
  ]).catch(() => 0n);

  const userOp: UserOperation = {
    sender:               userAddress,
    nonce:                ethers.toBeHex(nonce),
    callData:             execCalldata,
    callGasLimit:         ethers.toBeHex(300_000),
    verificationGasLimit: ethers.toBeHex(150_000),
    preVerificationGas:   ethers.toBeHex(50_000),
    maxFeePerGas:         ethers.toBeHex(maxFeePerGas),
    maxPriorityFeePerGas: ethers.toBeHex(maxPriorityFeePerGas),
    paymasterAndData:     relayResp.paymasterAndData,
    signature:            "0x", // filled below
  };

  // 6. Sign the UserOperation with the user's key
  const userOpHash = computeUserOpHash(userOp);
  const signature = await signer.signMessage(ethers.getBytes(userOpHash));
  userOp.signature = signature;

  // 7. Submit to bundler
  const submittedHash: string = await bundlerProvider.send(
    "eth_sendUserOperation",
    [userOp, ENTRY_POINT],
  );

  return {
    userOpHash: submittedHash,
    txHash:     submittedHash, // bundler returns userOpHash; receipt resolved async
    bundler:    PAYMASTER_BUNDLER_URL,
  };
}

// ── UserOp hash helper ────────────────────────────────────────────────────────

/**
 * Computes the ERC-4337 UserOperation hash (v0.7 packed format).
 * This is what the user signs, and what the paymaster verifies.
 */
function computeUserOpHash(op: UserOperation): string {
  const packed = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32", "bytes32",
     "bytes32", "uint256", "bytes32"],
    [
      op.sender,
      op.nonce,
      ethers.keccak256(op.callData),
      ethers.keccak256(op.paymasterAndData),
      ethers.solidityPackedKeccak256(
        ["uint128", "uint128"],
        [op.callGasLimit, op.verificationGasLimit],
      ),
      op.maxFeePerGas,
      ethers.solidityPackedKeccak256(
        ["uint128", "uint128"],
        [op.maxFeePerGas, op.maxPriorityFeePerGas],
      ),
    ],
  );
  return ethers.solidityPackedKeccak256(
    ["bytes32", "address", "uint256"],
    [packed, ENTRY_POINT, 11155111],
  );
}

// ── Status helper (used by CLI wallet dashboard) ──────────────────────────────

export interface PaymasterStatus {
  paymasterAddress:  string;
  relayUrl:          string;
  bundlerUrl:        string;
  configured:        boolean;
  relaySigner:       string;
  minOgBalanceEther: string;
}

/**
 * Returns current paymaster configuration for display in CLI dashboard.
 */
export function getPaymasterStatus(): PaymasterStatus {
  return {
    paymasterAddress:  PAYMASTER_ADDRESS  || "(not deployed)",
    relayUrl:          PAYMASTER_RELAY_URL,
    bundlerUrl:        PAYMASTER_BUNDLER_URL,
    configured:        !!PAYMASTER_ADDRESS,
    relaySigner:       RELAY_SIGNER_ADDRESS || "(not set)",
    minOgBalanceEther: MIN_OG_BALANCE_ETH,
  };
}
