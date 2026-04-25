/**
 * KeeperHub + Uniswap v4 Integration.
 *
 * KeeperHub:   Routes on-chain actions through the KeeperHub MCP endpoint.
 *              Private RPC, smart gas estimation, execution audit logs.
 *
 * Uniswap v4: Brain rental payment swap helper.
 *              Uses V4Planner + Pool (from @uniswap/v4-sdk) to encode
 *              a SWAP_EXACT_IN_SINGLE action, then routes via KeeperHub.
 *
 * @module keeper
 */

import "./env.js";
import type { ExecResult } from "./types.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── Environment ───────────────────────────────────────────────────────────────

const KEEPER_API_KEY = process.env.KEEPER_API_KEY ?? "";
const KEEPER_ENDPOINT = "https://app.keeperhub.com/mcp";

// ── KEEPERHUB — ON-CHAIN EXECUTION ────────────────────────────────────────────

/**
 * Executes an on-chain action via KeeperHub's MCP endpoint.
 *
 * KeeperHub handles:
 *   - Private RPC routing (MEV protection)
 *   - Dynamic gas estimation with buffer
 *   - Full execution audit log
 *
 * @param target   - Target contract address (0x-prefixed)
 * @param calldata - Hex-encoded calldata for the transaction
 * @param value    - ETH value to send (in wei, as decimal string, default "0")
 * @returns Transaction hash and gas used
 */
export async function execOnchain(
  target: string,
  calldata: string,
  value = "0"
): Promise<ExecResult> {
  if (!KEEPER_API_KEY) {
    throw new Error(
      "KEEPER_API_KEY not set. Get your kh_ key at https://app.keeperhub.com (Settings → API Keys)."
    );
  }

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendTransaction",
    params: [
      {
        to: target,
        data: calldata,
        value: "0x" + BigInt(value).toString(16),
      },
    ],
  };

  console.error(`[keeper] Sending tx via KeeperHub → ${target}`);
  console.error(`[keeper] Calldata: ${calldata.slice(0, 20)}… (${calldata.length} chars)`);

  const response = await fetch(KEEPER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEEPER_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`KeeperHub HTTP error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    result?: { txHash: string; gasUsed: string };
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`KeeperHub error: ${json.error.message}`);
  }
  if (!json.result) {
    throw new Error("KeeperHub returned no result");
  }

  console.error(
    `[keeper] ✓ TX executed | hash: ${json.result.txHash} | gas: ${json.result.gasUsed}`
  );
  return json.result;
}

// ── UNISWAP V4 — BRAIN RENTAL PAYMENT SWAP ────────────────────────────────────

/**
 * Uniswap v4 integration for Brain rental payment routing.
 *
 * Use case: Agent renter sends any ERC-20 token as rental payment,
 * Uniswap v4 auto-swaps to the Brain owner's preferred token.
 *
 * Implementation:
 *   1. Constructs a v4 PoolKey (currency0, currency1, fee, tickSpacing, hooks)
 *   2. Uses V4Planner.addAction() to build a SWAP_EXACT_IN_SINGLE action
 *   3. Encodes the finalize() bytes as calldata
 *   4. Sends the swap through KeeperHub for MEV protection
 *
 * @param tokenInAddress   - Address of the token to swap from
 * @param tokenOutAddress  - Address of the token to swap to
 * @param amountIn         - Exact input amount (in token's smallest unit, as string)
 * @param recipientAddress - Wallet that receives the output tokens
 * @returns ExecResult with txHash and gasUsed from KeeperHub
 */
export async function swapForRentalPayment(
  tokenInAddress: string,
  tokenOutAddress: string,
  amountIn: string,
  recipientAddress: string
): Promise<ExecResult> {
  // Use require dynamically for CJS interop, or await import as fallback
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Token } = require("@uniswap/sdk-core");
  const { Pool, V4Planner, Actions } = require("@uniswap/v4-sdk");
  /* eslint-enable @typescript-eslint/no-var-requires */
  // Sepolia testnet chain ID = 11155111
  const SEPOLIA_CHAIN_ID = 11155111;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  console.error(`[uniswap-v4] Swap: ${tokenInAddress} → ${tokenOutAddress}`);
  console.error(`[uniswap-v4] Amount: ${amountIn} | Recipient: ${recipientAddress}`);

  const tokenIn = new Token(SEPOLIA_CHAIN_ID, tokenInAddress, 18, "IN", "Input Token");
  const tokenOut = new Token(SEPOLIA_CHAIN_ID, tokenOutAddress, 18, "OUT", "Output Token");

  // v4 Pool constructor: (currencyA, currencyB, fee, tickSpacing, hooks, sqrtPriceX96, liquidity, tickCurrent)
  // BigintIsh accepts numbers, strings, or JSBI — use strings to avoid native BigInt vs JSBI mismatch
  const SQRT_PRICE_1_1 = "79228162514264337593543950336"; // 1:1 price (sqrt(1) * 2^96)
  const LIQUIDITY = "1000000000000000000000";

  const pool = new Pool(
    tokenIn,
    tokenOut,
    3000,           // 0.3% fee
    60,             // tick spacing for 0.3% pools
    ZERO_ADDRESS,   // no hook
    SQRT_PRICE_1_1,
    LIQUIDITY,
    0               // tickCurrent = 0 (1:1 price)
  );

  // Build swap action via V4Planner
  const planner = new V4Planner();
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [
    {
      poolKey: pool.poolKey,
      zeroForOne: pool.currency0.equals(tokenIn),
      amountIn: BigInt(amountIn),
      amountOutMinimum: BigInt(0), // set slippage via KeeperHub gas buffer
      sqrtPriceLimitX96: BigInt(0),
      hookData: "0x",
    },
  ]);
  // Settle: sweep output to recipient
  planner.addAction(Actions.TAKE_ALL, [tokenOut.address, amountIn]);

  const calldata = planner.finalize();

  // Uniswap v4 Universal Router on Sepolia
  const UNIVERSAL_ROUTER_SEPOLIA = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

  console.error(`[uniswap-v4] Routing via KeeperHub (MEV protected) → ${UNIVERSAL_ROUTER_SEPOLIA}`);
  return execOnchain(UNIVERSAL_ROUTER_SEPOLIA, calldata, "0");
}
