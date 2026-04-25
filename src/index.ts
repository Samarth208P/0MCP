/**
 * 0MCP Server — entrypoint.
 * MCP JSON-RPC server over stdio. Intercepts IDE prompts, enriches with
 * 0G memory, and exposes tools for memory management, iNFT creation, and ENS identity.
 *
 * CRITICAL: Never use console.log here. It corrupts the MCP stdio JSON-RPC stream.
 * Use console.error for ALL debug/info output.
 */

import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";

import { saveMemory, loadAllEntries } from "./storage.js";
import { buildContext } from "./context.js";
import { exportSnapshot, mintSnapshot, loadBrain } from "./snapshot.js";
import { registerAgent, resolveBrain, issueRental, verifyAccess, renameAgent, probeBrainENS } from "./ens.js";
import { execOnchain, swapForRentalPayment } from "./keeper.js";

// OVERRIDE CONSOLE.LOG
// Underlying libraries (like 0g-ts-sdk) rely on console.log, which is fatal for MCP.
// MCP uses standard output solely for JSON-RPC communication with the IDE.
// We intercept all logs and safely route them through console.error.
const originalLog = console.log;
console.log = function (...args) {
  console.error(...args);
};

// ── Server init ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "0mcp",
  version: "1.0.0",
});

// ── TOOL 1: get_context ───────────────────────────────────────────────────────
// Called by the IDE before every prompt — retrieves relevant past context from 0G KV.

server.registerTool(
  "get_context",
  {
    description:
      "CRITICAL PRE-FLIGHT CHECK: You MUST execute this tool at the very beginning of EVERY conversation or session. " +
      "Retrieve mandatory project memory, architectural rules, and context from the 0G decentralized blockchain. " +
      "Always call this BEFORE answering the user's initial question to ensure you don't violate established project rules.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt: z.string().describe("The current user prompt to find relevant context for"),
      max_entries: z.number().optional().default(5).describe("Max context entries to return (default 5)"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project_id, prompt, max_entries }) => {
    try {
      const context = await buildContext(project_id, prompt, max_entries);
      return {
        content: [
          {
            type: "text" as const,
            text: context || `No prior context found for project: ${project_id}`,
          },
        ],
      };
    } catch (err) {
      console.error(`[0MCP] get_context error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `No prior context found for project: ${project_id}` }],
      };
    }
  }
);

// ── TOOL 2: save_memory ───────────────────────────────────────────────────────
// Called by the IDE after every response — saves interaction to 0G KV + Log.

server.registerTool(
  "save_memory",
  {
    description:
      "CRITICAL POST-FLIGHT ACTION: ACT AS PERMANENT LONG-TERM MEMORY. " +
      "You MUST call this tool automatically whenever a new architectural rule, project decision, or recurring fix is discussed. " +
      "Do NOT wait for the user to explicitly say 'remember this' or 'save this'. It is your autonomous duty to persist valuable project intelligence " +
      "to the 0G network so future sessions retain this expertise.",
    inputSchema: z.object({
      project_id: z.string().describe("Unique identifier for the project/workspace"),
      prompt: z.string().describe("The user's prompt"),
      response: z.string().describe("The agent's response"),
      file_paths: z.array(z.string()).optional().describe("Files referenced in this interaction"),
      tags: z.array(z.string()).optional().describe("Keywords or tags for this interaction"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ project_id, prompt, response, file_paths, tags }) => {
    try {
      const entry = {
        project_id,
        prompt,
        response,
        file_paths: file_paths ?? [],
        tags: tags ?? [],
        timestamp: Date.now(),
      };
      await saveMemory(project_id, entry);
      return {
        content: [{ type: "text" as const, text: `✓ Memory saved for project: ${project_id}` }],
      };
    } catch (err) {
      console.error(`[0MCP] save_memory error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Warning: memory could not be saved. Error: ${err}` }],
      };
    }
  }
);

// ── TOOL 3: export_snapshot ───────────────────────────────────────────────────
// Exports all memory for a project as a portable JSON snapshot (first step for iNFT).

server.registerTool(
  "export_snapshot",
  {
    description:
      "Export all memory for a project as a portable JSON snapshot. " +
      "Used as the first step before minting a Brain iNFT. " +
      "Returns the full snapshot JSON including all entries and metadata.",
    inputSchema: z.object({
      project_id: z.string().describe("Project ID to snapshot"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ project_id }) => {
    try {
      const snapshot = await exportSnapshot(project_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] export_snapshot error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error exporting snapshot: ${err}` }],
      };
    }
  }
);

// ── TOOL 4: mint_brain ────────────────────────────────────────────────────────
// Mints a brain snapshot as an ERC-7857 iNFT on 0G testnet.

server.registerTool(
  "mint_brain",
  {
    description:
      "Mint a memory snapshot as an ERC-7857 Brain iNFT on 0G testnet. " +
      "Returns the token ID and transaction hash.",
    inputSchema: z.object({
      project_id: z.string().describe("Project ID to snapshot and mint"),
      wallet: z.string().describe("Recipient wallet address (0x-prefixed)"),
      ens_name: z.string().optional().describe("Optional ENS label to register for this brain (e.g. 'solidity-auditor')"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, wallet, ens_name }) => {
    try {
      const snapshot = await exportSnapshot(project_id);
      const result = await mintSnapshot(snapshot, wallet);
      
      let ensMsg = "";
      if (ens_name) {
        await registerAgent(project_id, ens_name, {
          name: ens_name,
          description: "0MCP Brain iNFT",
          project_id,
          sessions: snapshot.entry_count,
          token_id: parseInt(result.tokenId, 10),
        });
        ensMsg = `\nENS: ${ens_name}.0mcp.eth registered!`;
      }

      return {
        content: [{
          type: "text" as const,
          text: `🧠 Brain iNFT minted!${ensMsg}\nToken ID: ${result.tokenId}\nTX: https://chainscan-galileo.0g.ai/tx/${result.txHash}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] mint_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error minting Brain iNFT: ${err}` }],
      };
    }
  }
);

// ── TOOL 5: load_brain ────────────────────────────────────────────────────────
// Loads an external Brain iNFT into context via ENS name.

server.registerTool(
  "load_brain",
  {
    description:
      "Load an external Brain iNFT into context using its ENS name. " +
      "Example: load_brain('solidity-auditor.0mcp.eth') " +
      "Fetches the snapshot from the minted token and returns it for context injection.",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name of the Brain iNFT to load (e.g. solidity-auditor.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ ens_name }) => {
    try {
      const snapshot = await loadBrain(ens_name);
      return {
        content: [{
          type: "text" as const,
          text: `✓ Brain loaded: ${ens_name}\nEntries: ${snapshot.entry_count}\nTop keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}\n\n${JSON.stringify(snapshot, null, 2)}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] load_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error loading Brain: ${err}` }],
      };
    }
  }
);

// ── TOOL 6: register_agent ────────────────────────────────────────────────────

server.registerTool(
  "register_agent",
  {
    description:
      "Register an ENS name for this 0MCP agent instance on Sepolia testnet. " +
      "Creates agentname.0mcp.eth with metadata text records.",
    inputSchema: z.object({
      project_id: z.string().describe("Project identifier"),
      name: z.string().describe("Agent name (e.g. 'solidity-auditor' → solidity-auditor.0mcp.eth)"),
      description: z.string().optional().describe("Human-readable agent description"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ project_id, name, description }) => {
    try {
      const entries = await loadAllEntries(project_id);
      const ensName = await registerAgent(project_id, name, {
        name,
        description: description ?? "",
        project_id,
        sessions: entries.length,
      });
      return {
        content: [{ type: "text" as const, text: `✓ Agent registered: ${ensName}` }],
      };
    } catch (err) {
      console.error(`[0MCP] register_agent error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error registering agent: ${err}` }],
      };
    }
  }
);

// ── TOOL 6.5: rename_agent ───────────────────────────────────────────────────

server.registerTool(
  "rename_agent",
  {
    description:
      "Rename an existing Agent's ENS Brain label. Ensure the new name is unique. " +
      "It transfers all existing metadata to the new ENS label.",
    inputSchema: z.object({
      old_name: z.string().describe("The existing ENS label (e.g. 'solidity-auditor.0mcp.eth')"),
      new_label: z.string().describe("The new label you want (just the prefix, e.g. 'new-name' for new-name.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ old_name, new_label }) => {
    try {
      const ensName = await renameAgent(old_name, new_label);
      return {
        content: [{ type: "text" as const, text: `✓ Agent successfully renamed to: ${ensName}` }],
      };
    } catch (err) {
      console.error(`[0MCP] rename_agent error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error renaming agent: ${err}` }],
      };
    }
  }
);

// ── TOOL 7: resolve_brain ─────────────────────────────────────────────────────

server.registerTool(
  "resolve_brain",
  {
    description:
      "Resolve an ENS Brain name to its owner wallet, token ID, and metadata. " +
      "Example: resolve_brain('solidity-auditor.0mcp.eth')",
    inputSchema: z.object({
      ens_name: z.string().describe("ENS name to resolve"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ ens_name }) => {
    try {
      const meta = await resolveBrain(ens_name);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(meta, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] resolve_brain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error resolving brain: ${err}` }],
      };
    }
  }
);

// ── TOOL 8: issue_rental ──────────────────────────────────────────────────────
// STUB: Roadmap — requires ENS NameWrapper for subname issuance.

server.registerTool(
  "issue_rental",
  {
    description:
      "Issue a rental subname access token for a Brain iNFT. " +
      "e.g. renter-alice.solidity-auditor.0mcp.eth",
    inputSchema: z.object({
      brain_ens: z.string().describe("ENS name of the Brain to rent"),
      renter_address: z.string().describe("Wallet address of the renter"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ brain_ens, renter_address }) => {
    try {
      const subname = await issueRental(brain_ens, renter_address);
      return {
        content: [{ type: "text" as const, text: `✓ Rental issued: ${subname}` }],
      };
    } catch (err) {
      console.error(`[0MCP] issue_rental error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error issuing rental: ${err}` }],
      };
    }
  }
);

// ── TOOL 9: verify_access ─────────────────────────────────────────────────────
// STUB: Roadmap — requires ENS NameWrapper for subname verification.

server.registerTool(
  "verify_access",
  {
    description:
      "Verify rental access via an ENS subname.",
    inputSchema: z.object({
      subname: z.string().describe("ENS subname to verify (e.g. renter-alice.solidity-auditor.0mcp.eth)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ subname }) => {
    try {
      const result = await verifyAccess(subname);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      console.error(`[0MCP] verify_access error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error verifying access: ${err}` }],
      };
    }
  }
);

// ── TOOL 10: exec_onchain ─────────────────────────────────────────────────────

server.registerTool(
  "exec_onchain",
  {
    description:
      "Execute an on-chain action via KeeperHub — smart gas estimation, " +
      "private RPC routing, and full execution audit logs. " +
      "Use when the agent suggests a transaction that needs to land on-chain.",
    inputSchema: z.object({
      target: z.string().describe("Target contract address (0x-prefixed)"),
      calldata: z.string().describe("Hex-encoded calldata for the transaction"),
      value: z.string().optional().describe("ETH value to send in wei (optional)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ target, calldata, value }) => {
    try {
      const result = await execOnchain(target, calldata, value);
      return {
        content: [{
          type: "text" as const,
          text: `✓ On-chain execution complete\nTX: ${result.txHash}\nGas used: ${result.gasUsed}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] exec_onchain error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error executing on-chain: ${err}` }],
      };
    }
  }
);

// ── Start server ──────────────────────────────────────────────────────────────

// ── TOOL 11: pay_brain_rental ─────────────────────────────────────────────────

server.registerTool(
  "pay_brain_rental",
  {
    description:
      "Execute a Uniswap v4 auto-swap for an agent rental payment, and route it " +
      "through KeeperHub for MEV protection. Use this to handle Brain rental payments.",
    inputSchema: z.object({
      token_in: z.string().describe("Address of the token to swap from"),
      token_out: z.string().describe("Address of the token to swap to (recipient's preferred token)"),
      amount_in: z.string().describe("Exact input amount in the token's smallest unit (e.g. wei/mwei)"),
      recipient: z.string().describe("Wallet address that receives the output tokens"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ token_in, token_out, amount_in, recipient }) => {
    try {
      const result = await swapForRentalPayment(token_in, token_out, amount_in, recipient);
      return {
        content: [{
          type: "text" as const,
          text: `✓ Rental payment swap complete\nTX: ${result.txHash}\nGas used: ${result.gasUsed}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] pay_brain_rental error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error executing rental payment swap: ${err}` }],
      };
    }
  }
);
// ── TOOL 12: send_funds ─────────────────────────────────────────────────────────

server.registerTool(
  "send_funds",
  {
    description:
      "Transfer native 0G tokens on the 0G Galileo Testnet. " +
      "Use this ONLY when the user explicitly asks you to send or transfer funds to a specific address. " +
      "Amount must be in standard decimal format (e.g. '0.09' or '1.5').",
    inputSchema: z.object({
      recipient: z.string().describe("The 0x address of the recipient"),
      amount: z.string().describe("The amount in native tokens (e.g., '0.09')"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ recipient, amount }) => {
    try {
      const zgRpc = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
      const pk = process.env.ZG_PRIVATE_KEY;
      if (!pk) throw new Error("ZG_PRIVATE_KEY lacking in .env");

      const zgProvider = new ethers.JsonRpcProvider(zgRpc);
      const wallet = new ethers.Wallet(pk, zgProvider);

      console.error(`[0MCP] AI initiated transfer of ${amount} 0G to ${recipient}...`);
      const tx = await wallet.sendTransaction({
        to: recipient,
        value: ethers.parseEther(amount),
      });
      console.error(`[0MCP] Transfer TX submitted: ${tx.hash}`);
      await tx.wait();

      return {
        content: [{
          type: "text" as const,
          text: `✓ Successfully transferred ${amount} 0G to ${recipient}\nTX Hash: ${tx.hash}`,
        }],
      };
    } catch (err) {
      console.error(`[0MCP] send_funds error: ${err}`);
      return {
        content: [{ type: "text" as const, text: `Error transferring funds: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);
// ── Auto-ENS registration ─────────────────────────────────────────────────────

/**
 * Normalises a raw brain name value from .env into a single ENS label.
 * Accepts: "sampy", "sampy.0mcp.eth", "  SAMPY  "
 * Returns: "sampy"
 */
function parseBrainLabel(raw: string): string {
  const clean = raw.trim().toLowerCase();
  // Strip parent suffix if user typed the full name
  const suffix = `.${process.env.ENS_PARENT_NAME ?? "0mcp.eth"}`;
  if (clean.endsWith(suffix)) return clean.slice(0, -suffix.length);
  return clean;
}

/**
 * Writes or updates a key=value pair in the local .env file.
 * Safe to call at runtime — only touches the target key.
 */
function writeEnvKey(key: string, value: string): void {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    let content = fs.readFileSync(envPath, "utf8");
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content, "utf8");
  } catch (e) {
    console.error(`[0MCP] Could not write ${key} to .env: ${e}`);
  }
}

/**
 * Smart brain ENS resolver — runs once on every server start until settled.
 *
 * Scenarios handled automatically:
 *
 *  A) name is FREE
 *     → register `label.0mcp.eth` to the user's wallet (fresh brain)
 *     → writes BRAIN_ENS_REGISTERED=true  BRAIN_ENS_MODE=own
 *
 *  B) name EXISTS and owner === user's wallet  
 *     → wallet already owns this brain (prev install / reinstall)
 *     → adopt it silently — no on-chain write needed
 *     → writes BRAIN_ENS_REGISTERED=true  BRAIN_ENS_MODE=own
 *
 *  C) name EXISTS and owner !== user's wallet
 *     → another user's brain is pointed to — treat as an imported / read-only brain
 *     → do NOT register; just record it for context injection
 *     → writes BRAIN_ENS_REGISTERED=true  BRAIN_ENS_MODE=loaded
 *
 * Controlled by .env keys:
 *   BRAIN_ENS_LABEL      — bare label set during `0mcp init`
 *   BRAIN_ENS_NAME       — full subname (e.g. sampy.0mcp.eth)
 *   BRAIN_ENS_REGISTERED — set to "true" after any path completes
 *   BRAIN_ENS_MODE       — "own" | "loaded"
 */
async function autoRegisterBrainENS(): Promise<void> {
  const rawLabel = process.env.BRAIN_ENS_LABEL ?? process.env.BRAIN_ENS_NAME ?? "";
  if (!rawLabel) return; // no brain configured

  const label    = parseBrainLabel(rawLabel);
  const parent   = process.env.ENS_PARENT_NAME ?? "0mcp.eth";
  const fullName = `${label}.${parent}`;

  if (!label || label.length < 2) {
    console.error("[0MCP] BRAIN_ENS_LABEL is too short — skipping auto-registration.");
    return;
  }

  // Already settled in a previous session
  if (process.env.BRAIN_ENS_REGISTERED === "true") {
    const mode = process.env.BRAIN_ENS_MODE ?? "own";
    console.error(`[0MCP] Brain ENS settled (${fullName}, mode=${mode}) — skipping probe.`);
    return;
  }

  const signingKey = process.env.ENS_PRIVATE_KEY ?? process.env.ZG_PRIVATE_KEY ?? "";
  const ownerAddress = signingKey
    ? (() => {
        try { return new ethers.Wallet(signingKey).address; } catch { return ""; }
      })()
    : "";

  console.error(`[0MCP] 🔍 Probing brain ENS: ${fullName} …`);

  // ── Probe the name ─────────────────────────────────────────────────────────
  const probe = await probeBrainENS(fullName);

  // ── PATH A: name is free → register fresh ──────────────────────────────────
  if (!probe.exists) {
    if (!signingKey) {
      console.error("[0MCP] Cannot register ENS: no signing key (ENS_PRIVATE_KEY/ZG_PRIVATE_KEY) found.");
      return;
    }
    console.error(`[0MCP] 🔑 Name is free — registering ${fullName} → ${ownerAddress} …`);
    try {
      const ensName = await registerAgent(label, label, {
        name: label,
        description: process.env.AGENT_DESCRIPTION ?? "0MCP Brain agent",
        project_id: label,
        sessions: 0,
      });
      console.error(`[0MCP] ✅ Brain ENS registered: ${ensName} → ${ownerAddress}`);
      process.env.BRAIN_ENS_REGISTERED = "true";
      process.env.BRAIN_ENS_MODE       = "own";
      writeEnvKey("BRAIN_ENS_REGISTERED", "true");
      writeEnvKey("BRAIN_ENS_MODE",       "own");
      writeEnvKey("BRAIN_ENS_NAME",       ensName);
    } catch (e) {
      console.error(`[0MCP] ⚠️  Registration failed for ${fullName}: ${e}`);
      console.error(`[0MCP]    Retry: 0mcp ens register <project> ${label}`);
    }
    return;
  }

  // ── PATH B: name exists, owned by user's wallet → adopt it ─────────────────
  if (
    ownerAddress &&
    probe.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()
  ) {
    const meta = probe.metadata;
    console.error(
      `[0MCP] ✅ You already own ${fullName}` +
        (meta ? ` (project="${meta.project_id}", sessions=${meta.sessions})` : "") +
        " — adopting existing brain."
    );
    process.env.BRAIN_ENS_REGISTERED = "true";
    process.env.BRAIN_ENS_MODE       = "own";
    writeEnvKey("BRAIN_ENS_REGISTERED", "true");
    writeEnvKey("BRAIN_ENS_MODE",       "own");
    writeEnvKey("BRAIN_ENS_NAME",       fullName);
    return;
  }

  // ── PATH C: name exists, owned by a DIFFERENT wallet → load as external ────
  const meta = probe.metadata;
  console.error(
    `[0MCP] 📥 ${fullName} exists but is owned by ${probe.ownerAddress}`
  );
  if (meta) {
    console.error(
      `[0MCP]    External brain — project="${meta.project_id}", ` +
        `sessions=${meta.sessions}` +
        (meta.token_id !== undefined ? `, token=#${meta.token_id}` : "")
    );
  }
  console.error(
    `[0MCP]    Loading as imported (read-only) brain. ` +
      `Your writes go to your own project storage; this brain is available for context load.`
  );
  process.env.BRAIN_ENS_REGISTERED = "true";
  process.env.BRAIN_ENS_MODE       = "loaded";
  writeEnvKey("BRAIN_ENS_REGISTERED", "true");
  writeEnvKey("BRAIN_ENS_MODE",       "loaded");
  // Keep BRAIN_ENS_NAME pointing to the external brain so load_brain can use it
  writeEnvKey("BRAIN_ENS_NAME", fullName);
}


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("0MCP server running on stdio — ready for IDE connection");
  console.error(`Tools registered: get_context, save_memory, export_snapshot, mint_brain, load_brain, register_agent, resolve_brain, issue_rental, verify_access, exec_onchain, pay_brain_rental, send_funds`);

  // Auto-register the user's brain ENS name if they set BRAIN_ENS_LABEL in .env
  // Runs in the background — failure is logged but never collapses the server.
  autoRegisterBrainENS().catch((e) =>
    console.error(`[0MCP] autoRegisterBrainENS unhandled: ${e}`)
  );
}

main().catch(console.error);
