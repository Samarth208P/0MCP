#!/usr/bin/env node
/**
 * 0MCP CLI — Human-facing terminal interface for the 0MCP system.
 *
 * Usage: 0mcp <command> [subcommand] [options]
 *
 * This is separate from the MCP stdio server (src/index.ts).
 * Use this for setup, key generation, health checks, memory browsing,
 * Brain iNFT management, and ENS operations — all from the terminal.
 *
 * IMPORTANT: Uses process.stdout for all user-facing output (not stderr).
 *            stderr is reserved for debug/trace from the library modules.
 */

import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { lookupPrimaryBrain } from "./ens.js";
import { TxLogger } from "./txlogger.js";
import { withRetry } from "./utils.js";

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

const c = {
  reset:   (s: string) => NO_COLOR ? s : `\x1b[0m${s}\x1b[0m`,
  bold:    (s: string) => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
  dim:     (s: string) => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`,
  green:   (s: string) => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string) => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`,
  cyan:    (s: string) => NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`,
  red:     (s: string) => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => NO_COLOR ? s : `\x1b[35m${s}\x1b[0m`,
  blue:    (s: string) => NO_COLOR ? s : `\x1b[34m${s}\x1b[0m`,
};

// ── Output primitives ─────────────────────────────────────────────────────────

// IMPORTANT: For MCP compatibility, we MUST use stderr for all human-facing logs.
// The stdout channel is reserved strictly for JSON-RPC protocol messages.
const out  = (s: string)                => process.stderr.write(s + "\n");
const ok   = (s: string)                => out(`  ${c.green("✓")} ${s}`);
const err  = (s: string)                => out(`  ${c.red("✗")} ${s}`);
const warn = (s: string)                => out(`  ${c.yellow("⚠")} ${s}`);
const info = (s: string)                => out(`  ${c.cyan("·")} ${s}`);
const bull = (s: string)                => out(`  ${c.dim("►")} ${s}`);
const nl   = ()                         => out("");

function header(title: string): void {
  const bar = "─".repeat(58);
  nl();
  out(c.bold(c.cyan(`┌${bar}┐`)));
  out(c.bold(c.cyan(`│  ${title.padEnd(56)}│`)));
  out(c.bold(c.cyan(`└${bar}┘`)));
  nl();
}

function jsonOut(data: unknown): void {
  out(JSON.stringify(data, null, 2));
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface ParsedArgs {
  command:    string;
  sub1:       string;
  sub2:       string;
  positional: string[];       // everything that isn't a flag
  flags:      Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  return {
    command:    positional[0] ?? "",
    sub1:       positional[1] ?? "",
    sub2:       positional[2] ?? "",
    positional,
    flags,
  };
}

function flag(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return v === true ? undefined : v;
}

function hasFlag(flags: Record<string, string | true>, key: string): boolean {
  return key in flags;
}

/**
 * Persists key-value pairs to the .env.0mcp file in the current directory.
 */
function persistEnv(updates: Record<string, string>): void {
  const envPath = path.resolve(process.cwd(), ".env.0mcp");
  if (!fs.existsSync(envPath)) return;
  
  let content = fs.readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  fs.writeFileSync(envPath, content);
}

// ── Readline helper (for init wizard) ────────────────────────────────────────

async function prompt(question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve) => {
    const def = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : "";
    process.stdout.write(`  ${c.cyan("?")} ${question}${def}: `);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data: Buffer | string) => {
      process.stdin.pause();
      const trimmed = data.toString().trim();
      resolve(trimmed || defaultVal);
    });
  });
}

// ── COMMAND: help ─────────────────────────────────────────────────────────────

function printHelp(): void {
  out("");
  out(c.bold(c.cyan("  0MCP") + " — Persistent Memory Layer for AI Coding Agents"));
  out(c.dim("  Powered by 0G · ENS · Brain iNFT"));
  out("");
  out(c.bold("  USAGE"));
  out("    " + c.cyan("0mcp") + " <command> [subcommand] [options]");
  out("    " + c.cyan("0mcp start") + "                         " + c.dim("Launch the MCP server (for use in Cursor/VS Code)"));
  out("");

  const row = (cmd: string, desc: string) =>
    out(`    ${c.cyan(cmd.padEnd(44))} ${c.dim(desc)}`);

  out(c.bold("  SETUP"));
  row("init",                                       "Interactive setup wizard — generates keys + scaffolds .env");
  row("health",                                     "Check 0G RPC, indexer, registry, ENS Sepolia");
  out("");
  out(c.bold("  WALLET & FUNDS"));
  row("wallet status [--json]",                     "Show balances, brain identity, paymaster status");
  row("wallet send <asset> <recipient> <amount>",   "Send 0G or ETH to another address (asset: 0g or eth)");
  row("wallet projects [--json]",                   "List all known projects in storage");
  row("keygen [--save]",                            "Generate Ethereum keypair (safe offline)");
  out("");
  out(c.bold("  MEMORY"));
  row("memory list <project-id> [--json]",          "List all saved memory entries");
  row("memory export <project-id> [--file <path>]", "Export full snapshot JSON to stdout or file");
  out("");
  out(c.bold("  BRAIN"));
  row("brain mint <project-id> [--recipient <addr>] [--ens <label>]", "Mint Brain iNFT + register ENS in one step");
  row("brain load <ens-name> --into <project-id>",     "Load external Brain into local project");
  row("brain share <project-id> [--json]",             "Show ENS name + token ID");
  row("brain status <project-id> [--json]",            "Show token, contract, entry count");
  out("");
  out(c.bold("  ENS"));
  row("ens register <project-id> <label>",          "Register <label>.0mcp.eth subname");
  row("ens rename <old-name> <new-label>",          "Rename an existing Brain ENS name");
  row("ens resolve <ens-name> [--json]",            "Resolve ENS → metadata JSON");
  row("ens issue <brain-ens> <renter-addr>",        "Issue a rental subname");
  row("ens verify <subname> [--json]",              "Verify rental access");
  out("");
  out(c.bold("  INFT"));
  row("inft status <contract> <token-id> [--json]", "Check tokenURI on 0G testnet");
  out("");
  out(c.bold("  FLAGS"));
  out(`    ${c.cyan("--json")}     Output raw JSON (all read commands)`);
  out(`    ${c.cyan("--save")}     Persist generated keys to .env`);
  out(`    ${c.cyan("--file")}     Write output to file instead of stdout`);
  out("");
}

// ── COMMAND: keygen ───────────────────────────────────────────────────────────

async function cmdKeygen(flags: Record<string, string | true>): Promise<void> {
  header("KEY GENERATOR");
  info("Generating new Ethereum keypair (works offline)…");
  nl();

  const wallet = ethers.Wallet.createRandom();
  const privateKey = wallet.privateKey;
  const address = wallet.address;
  const mnemonic = wallet.mnemonic?.phrase ?? "(no mnemonic — HD wallet not available)";

  out(c.bold("  Address (public):"));
  out(`    ${c.green(address)}`);
  nl();
  out(c.bold("  Private Key:"));
  out(`    ${c.yellow(privateKey)}`);
  nl();
  out(c.bold("  Mnemonic (12 words):"));
  out(`    ${c.dim(mnemonic)}`);
  nl();
  warn("NEVER share your private key. Store mnemonic offline (paper/hardware wallet).");
  warn("Add to .env.0mcp as ZG_PRIVATE_KEY and ENS_PRIVATE_KEY.");
  nl();
  info("Get testnet tokens:");
  bull("0G Galileo OG tokens  → https://faucet.0g.ai");
  bull("Sepolia ETH           → https://sepoliafaucet.com");
  nl();
  if (hasFlag(flags, "save")) {
    persistEnv({ ZG_PRIVATE_KEY: privateKey });
    ok("Keys saved to .env.0mcp (ZG_PRIVATE_KEY)");
  }
}

// ── COMMAND: init ─────────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  header("0MCP INIT");
  info("Generates your .env.0mcp in 4 questions.");
  nl();

  // Q1: Private Key
  let privateKey = await prompt("Your Private Key (optional — leave empty for KeeperHub Managed Wallet)", "");
  let address = "";
  if (!privateKey) {
    info("No key provided. Using KeeperHub Managed Wallet for identity.");
    privateKey = ""; // Explicitly empty
  } else {
    const { ethers } = await import("ethers");
    try {
      const w = new ethers.Wallet(privateKey);
      address = w.address;
      ok(`Wallet: ${c.green(address)}`);
      warn("Save your private key safely — not shown again.");
      nl();
    } catch (e) {
      err(`Invalid private key: ${e}`);
      process.exit(1);
    }
  }

  // Q2: Project ID
  const currentFolder = path.basename(process.cwd());
  const project_id = await prompt("Project ID", currentFolder);

  const { saveProjectLocation } = await import("./registry.js");
  saveProjectLocation(project_id, process.cwd());

  // Q3: Brain name
  const brainLabel = await prompt(`Brain ENS label (e.g. 'myagent' → myagent.0mcp.eth)`, "");

  // Write .env.0mcp
  const envContent = `# 0MCP Environment — generated by 0mcp init
# DO NOT commit this file to git.

PROJECT_ID=${project_id}
ZG_PRIVATE_KEY=${privateKey}
BRAIN_ENS_LABEL=${brainLabel}
BRAIN_ENS_NAME=${brainLabel ? `${brainLabel}.0mcp.eth` : ""}

# Defaults (pre-deployed on testnet — change only if you self-deploy)
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
MEMORY_REGISTRY_ADDRESS=0xC5887CA90aC2A5c6f1E7FC536A5363B961F18813
INFT_CONTRACT_ADDRESS=0xd07059e54017BbF424223cb089ffBC5e2558cF56
PAYMASTER_ADDRESS=0xb1Ab695dbcbA334A60712234d46264A617AD6d7f
SUBNAME_REGISTRAR_ADDRESS=0xA2C96740159b7a47541DEfF991aD5edfa671661d
`;

  const envPath = path.resolve(process.cwd(), ".env.0mcp");
  fs.writeFileSync(envPath, envContent);
  ok(".env.0mcp written.");

  nl();
  out(c.bold("  Next steps:"));
  bull(`Fund wallet with 0G tokens → https://faucet.0g.ai`);
  bull(`Check health              → 0mcp health`);
  if (brainLabel) {
    bull(`Register ENS Brain        → 0mcp ens register ${project_id} ${brainLabel}`);
  }
  bull(`Run demo                  → 0mcp demo`);
  nl();
}

// ── COMMAND: health ───────────────────────────────────────────────────────────

async function cmdHealth(): Promise<void> {
  header("SYSTEM HEALTH CHECK");

  // 0G storage health
  info("Checking 0G storage backend…");
  try {
    const { checkStorageHealth } = await import("./storage.js");
    const health = await checkStorageHealth();
    out(`    Storage:     ${health.kvHealthy ? c.green("healthy") : c.red("unhealthy")}${health.kvEndpoint ? c.dim(` (${health.kvEndpoint})`) : ""}`);
    out(`    Indexer:     ${health.indexerHealthy ? c.green("healthy") : c.red("unhealthy")}${health.indexerEndpoint ? c.dim(` (RPC: ${health.indexerEndpoint})`) : ""}`);
    out(`    Explorer:    ${c.cyan("https://storagescan-galileo.0g.ai")}`);
    if (health.issues.length > 0) {
      nl();
      health.issues.forEach((issue) => warn(issue));
    }
    if (health.kvHealthy && health.indexerHealthy) {
      nl(); ok("0G backend is healthy");
    }
  } catch (e) {
    err(`0G check failed: ${e}`);
  }

  nl();

  // Sepolia / ENS connectivity
  info("Checking Sepolia ENS connectivity…");
  const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const ensRegistry = process.env.ENS_REGISTRY_ADDRESS ?? "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
  try {
    const provider = new ethers.JsonRpcProvider(sepoliaRpc);
    const network = await Promise.race([
      provider.getNetwork(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
    const chainId = Number(network.chainId);
    if (chainId !== 11155111) {
      warn(`Sepolia chain ID mismatch: expected 11155111, got ${chainId}`);
    } else {
      out(`    Sepolia RPC: ${c.green("healthy")} ${c.dim(`(${sepoliaRpc})`)}`);
    }

    // Ping ENS registry
    const registryAbi = ["function owner(bytes32 node) external view returns (address)"];
    const registry = new ethers.Contract(ensRegistry, registryAbi, provider);
    await Promise.race([
      (registry.owner as (node: string) => Promise<string>)(ethers.namehash("eth")),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
    ]);
    out(`    ENS Registry: ${c.green("reachable")} ${c.dim(`(${ensRegistry})`)}`);
    nl(); ok("ENS / Sepolia endpoint is healthy");
  } catch (e) {
    err(`Sepolia/ENS check failed: ${e}`);
  }

  // .env.0mcp presence
  nl();
  info("Checking .env.0mcp configuration…");
  const required: Array<[string, string]> = [
    ["ZG_PRIVATE_KEY",          "0G transactions and ENS writes"],
  ];
  for (const [key, purpose] of required) {
    const val = process.env[key];
    const missing = !val || val.includes("your_") || val.includes("_here");
    out(`    ${missing ? c.yellow("?") : c.green("✓")} ${key.padEnd(28)} ${missing ? c.dim(`(${purpose} — not set)`) : c.dim("set")}`);
  }
  nl();
}

// ── COMMAND: memory list ──────────────────────────────────────────────────────

async function cmdMemoryList(project: string, flags: Record<string, string | true>): Promise<void> {
  if (!project) { err("Usage: 0mcp memory list <project-id>"); process.exit(1); }

  const { loadAllEntries } = await import("./storage.js");
  const entries = await loadAllEntries(project);

  if (hasFlag(flags, "json")) {
    jsonOut(entries);
    return;
  }

  header(`MEMORY — ${project}`);
  if (entries.length === 0) {
    warn(`No memory entries found for project: ${project}`);
    return;
  }
  out(c.bold(`  ${entries.length} entries`));
  nl();
  for (const [i, e] of entries.entries()) {
    out(`  ${c.cyan(`[${i + 1}]`)} ${c.dim(new Date(e.timestamp).toISOString())}`);
    out(`      ${c.bold("Prompt:")} ${e.prompt.slice(0, 80)}${e.prompt.length > 80 ? "…" : ""}`);
    out(`      ${c.bold("Tags:")}   ${e.tags.join(", ") || c.dim("none")}`);
    if (e.file_paths.length > 0) {
      out(`      ${c.bold("Files:")}  ${e.file_paths.slice(0, 3).join(", ")}`);
    }
    nl();
  }
}

// ── COMMAND: memory export ────────────────────────────────────────────────────

async function cmdMemoryExport(project: string, flags: Record<string, string | true>): Promise<void> {
  if (!project) { err("Usage: 0mcp memory export <project-id> [--file <path>]"); process.exit(1); }

  info(`Exporting snapshot for project: ${project}…`);
  const { exportSnapshot } = await import("./snapshot.js");
  const snapshot = await exportSnapshot(project);
  const json = JSON.stringify(snapshot, null, 2);

  const filePath = flag(flags, "file");
  if (filePath) {
    fs.writeFileSync(filePath, json, "utf8");
    ok(`Snapshot written to: ${filePath}`);
    info(`Entries: ${snapshot.entry_count} | Size: ${json.length} bytes`);
  } else {
    process.stdout.write(json + "\n");
  }
}

// ── COMMAND: brain mint ───────────────────────────────────────────────────────

async function cmdBrainMint(project: string, flags: Record<string, string | true>): Promise<void> {
  TxLogger.clear();
  if (!project) { err("Usage: 0mcp brain mint <project-id> [--recipient <wallet>] [--ens <label>]"); process.exit(1); }

  let recipient = flag(flags, "recipient") as string | undefined;
  if (!recipient) {
    const pk = process.env.ZG_PRIVATE_KEY;
    if (pk) {
      recipient = new ethers.Wallet(pk).address;
    } else {
      err("Recipient wallet required. Use --recipient <addr> or set ZG_PRIVATE_KEY in .env");
      process.exit(1);
    }
  }

  header("BRAIN INFT — MINT");
  info(`Project:   ${project}`);
  info(`Recipient: ${recipient}`);
  nl();

  const { exportSnapshot, mintSnapshot } = await import("./snapshot.js");
  const { registerAgent } = await import("./ens.js");

  info("Exporting snapshot…");
  const snapshot = await exportSnapshot(project);
  ok(`Snapshot ready — ${snapshot.entry_count} entries`);
  nl();
  info("Minting on 0G testnet (this may take 30–60s)…");
  const result = await mintSnapshot(snapshot, recipient);
  ok(`Brain iNFT minted!`);
  out(`    Token ID: ${c.bold(result.tokenId)}`);
  out(`    TX:       ${c.cyan(`https://chainscan-galileo.0g.ai/tx/${result.txHash}`)}`);

  const ensLabel = flag(flags, "ens");
  if (ensLabel) {
    nl();
    info(`Naming brain: ${ensLabel}.0mcp.eth…`);
    const ensName = await registerAgent(project, ensLabel, {
      name: ensLabel,
      description: process.env.AGENT_DESCRIPTION ?? "0MCP Brain agent",
      project_id: project,
      sessions: snapshot.entry_count,
      token_id: parseInt(result.tokenId, 10),
    });
    ok(`ENS name registered: ${c.bold(ensName)}`);
    persistEnv({
      BRAIN_ENS_NAME: ensName,
      BRAIN_ENS_LABEL: ensLabel,
      BRAIN_ENS_MODE: "own"
    });
  }

  out(TxLogger.summary());
  nl();
  if (!ensLabel) info("Next: run `0mcp ens register` to create an ENS name for this Brain.");
}

// ── COMMAND: brain load ───────────────────────────────────────────────────────

async function cmdBrainLoad(ensName: string, flags: Record<string, string | true>): Promise<void> {
  if (!ensName) { err("Usage: 0mcp brain load <ens-name> --into <project-id>"); process.exit(1); }
  const intoProject = flag(flags, "into");
  if (!intoProject) { err("--into <project-id> is required"); process.exit(1); }

  header(`BRAIN LOAD — ${ensName}`);
  info(`Loading brain from ENS: ${ensName}…`);
  const { loadBrain } = await import("./snapshot.js");
  const snapshot = await loadBrain(ensName);

  nl();
  ok(`Brain loaded: ${ensName}`);
  out(`    Entries:      ${snapshot.entry_count}`);
  out(`    Top keywords: ${snapshot.metadata.top_keywords.slice(0, 5).join(", ")}`);
  out(`    Date range:   ${new Date(snapshot.metadata.date_range.first).toISOString().split("T")[0]} → ${new Date(snapshot.metadata.date_range.last).toISOString().split("T")[0]}`);
  
  persistEnv({
    BRAIN_ENS_NAME: ensName,
    BRAIN_ENS_MODE: "loaded"
  });
  nl();
  info(`This snapshot is ready to inject into project: ${intoProject}`);
  info("(Full snapshot JSON available via: 0mcp memory export)");
}

// ── COMMAND: brain share ──────────────────────────────────────────────────────

async function cmdBrainShare(project: string, flags: Record<string, string | true>): Promise<void> {
  if (!project) { err("Usage: 0mcp brain share <project-id>"); process.exit(1); }

  const { loadAllEntries } = await import("./storage.js");
  const entries = await loadAllEntries(project);
  const parentName = process.env.ENS_PARENT_NAME ?? "0mcp.eth";
  // Prefer the registered brain name, fall back to slugified project id
  const ensName = process.env.BRAIN_ENS_NAME ||
    `${(process.env.BRAIN_ENS_LABEL || project).replace(/[^a-z0-9-]/g, "-").toLowerCase()}.${parentName}`;
  const inftAddr = process.env.INFT_CONTRACT_ADDRESS ?? "(not deployed)";

  if (hasFlag(flags, "json")) {
    jsonOut({ ens_name: ensName, inft_contract: inftAddr, entry_count: entries.length, project_id: project });
    return;
  }

  header(`BRAIN SHARE — ${project}`);
  ok(`ENS name:       ${c.bold(ensName)}`);
  info(`iNFT contract:  ${inftAddr}`);
  info(`Project ID:     ${project}`);
  info(`Entries:        ${entries.length}`);
  nl();
  out(c.bold("  Share this ENS name so others can load your Brain:"));
  out(`    ${c.cyan(`0mcp brain load ${ensName} --into <their-project-id>`)}`);
  nl();
}

// ── COMMAND: brain status ─────────────────────────────────────────────────────

async function cmdBrainStatus(project: string, flags: Record<string, string | true>): Promise<void> {
  if (!project) { err("Usage: 0mcp brain status <project-id>"); process.exit(1); }

  const { loadAllEntries } = await import("./storage.js");
  const entries = await loadAllEntries(project);
  const inftAddr = process.env.INFT_CONTRACT_ADDRESS ?? "";
  // Use BRAIN_ENS_NAME if set (registered), otherwise derive from project id
  const parentName = process.env.ENS_PARENT_NAME ?? "0mcp.eth";
  const ensName = process.env.BRAIN_ENS_NAME ||
    `${(process.env.BRAIN_ENS_LABEL || project).replace(/[^a-z0-9-]/g, "-").toLowerCase()}.${parentName}`;
  const brainMode = process.env.BRAIN_ENS_MODE ?? "";

  const result = {
    project_id: project,
    entry_count: entries.length,
    inft_contract: inftAddr || null,
    ens_name: ensName,
    ens_mode: brainMode || null,
  };

  if (hasFlag(flags, "json")) { jsonOut(result); return; }

  header(`BRAIN STATUS — ${project}`);
  out(`    Project:        ${project}`);
  out(`    Entries (local):${c.bold(String(entries.length))}`);
  out(`    iNFT contract:  ${inftAddr ? c.green(inftAddr) : c.dim("(not set)")}`);
  out(`    ENS name:       ${ensName}${
    brainMode === "own"    ? c.dim(" (yours)") :
    brainMode === "loaded" ? c.dim(" (imported)") : ""}`);
  
  // Proactive discovery for iNFTs if local entries are low or contract not showing
  if (process.env.ZG_PRIVATE_KEY) {
    const address = new ethers.Wallet(process.env.ZG_PRIVATE_KEY).address;
    const zgRpc = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const zgProvider = new ethers.JsonRpcProvider(zgRpc);
    const inftContract = new ethers.Contract(inftAddr, [
      "function balanceOf(address) view returns (uint256)",
      "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
      "function tokenURI(uint256 tokenId) view returns (string)"
    ], zgProvider);

    interface FoundBrain {
      tokenId: string;
      projectId: string;
      entries: number;
    }
    const scanned: FoundBrain[] = [];

    try {
      const bal = await inftContract.balanceOf(address);
      if (bal > 0n) {
        nl();
        out(c.bold(`  🧠 Brain Scanner — Found ${bal} Brain iNFTs on 0G testnet:`));
        for (let i = 0; i < Number(bal); i++) {
          const tid = await inftContract.tokenOfOwnerByIndex(address, i);
          const uri = await inftContract.tokenURI(tid);
          const b64 = uri.match(/^data:application\/json;base64,(.+)$/);
          if (b64) {
            const json = JSON.parse(Buffer.from(b64[1], "base64").toString("utf8"));
            const pId = json.project_id || "unnamed";
            scanned.push({ tokenId: tid.toString(), projectId: pId, entries: json.entry_count });
            out(`    ${c.cyan(`[${i + 1}]`)} ${c.bold(pId.padEnd(20))} ${c.dim(`(Token: ${tid}, Entries: ${json.entry_count})`)}`);
          }
        }
        nl();
        const loadChoice = await prompt("Select a brain to LOAD into this project, or 'n' to skip", "n");
        if (loadChoice.toLowerCase() !== "n") {
          const idx = parseInt(loadChoice, 10) - 1;
          const chosen = scanned[idx];
          if (chosen) {
            // Need to find if it has an ENS name. We'll try to resolve it via owner lookup or let user type.
            const lookup = await lookupPrimaryBrain(address);
            let targetName = lookup || "";
            if (!targetName || !targetName.includes(chosen.projectId.toLowerCase())) {
               targetName = await prompt(`Enter ENS name for ${chosen.projectId} to load (e.g. name.0mcp.eth)`, `${chosen.projectId.toLowerCase()}.0mcp.eth`);
            }
            
            await cmdBrainLoad(targetName, { into: project });
          }
        }
      }
    } catch { /* ignore */ }
  }

  out(`    Storage:        ${c.green("0G Galileo testnet")}`);
  nl();
}

// ── COMMAND: ens register ─────────────────────────────────────────────────────

async function cmdEnsRegister(project: string, label: string, tokenIdOverride?: string): Promise<void> {
  TxLogger.clear();
  if (!project || !label) { err("Usage: 0mcp ens register <project-id> <label> [token-id]"); process.exit(1); }

  header(`ENS REGISTER — ${label}.0mcp.eth`);
  info(`Project: ${project}`);
  info(`Label:   ${label}`);
  if (tokenIdOverride) info(`Brain:   Token #${tokenIdOverride}`);
  nl();

  const { loadAllEntries } = await import("./storage.js");
  const { registerAgent } = await import("./ens.js");
  info("Loading project memory…");
  const entries = await loadAllEntries(project);
  info(`Registering ENS subname (sponsored gas-free via Paymaster; may take 30-90s)…`);

  const ensName = await registerAgent(project, label, {
    name: label,
    description: process.env.AGENT_DESCRIPTION ?? "0MCP Brain agent",
    project_id: project,
    sessions: entries.length,
    token_id: tokenIdOverride ? parseInt(tokenIdOverride, 10) : undefined
  });

  nl();
  ok(`ENS name registered: ${c.bold(ensName)}`);
  persistEnv({
    BRAIN_ENS_NAME: ensName,
    BRAIN_ENS_LABEL: label,
    BRAIN_ENS_MODE: "own"
  });
  nl();
  info("Next steps:");
  bull(`Mint iNFT:         0mcp brain mint ${project}`);
  bull(`Share with others: 0mcp brain share ${project}`);
  out(TxLogger.summary());
  nl();
}

// ── COMMAND: ens rename ───────────────────────────────────────────────────────

async function cmdEnsRename(oldName: string, newLabel: string): Promise<void> {
  TxLogger.clear();
  if (!oldName || !newLabel) { err("Usage: 0mcp ens rename <old-name> <new-label>"); process.exit(1); }

  header(`ENS RENAME — ${oldName} → ${newLabel}.0mcp.eth`);
  info(`Old Name:  ${oldName}`);
  info(`New Label: ${newLabel}`);
  nl();

  const { renameAgent } = await import("./ens.js");
  info(`Renaming ENS brain (sponsored gas-free via Paymaster; may take 30-90s)…`);

  const newEnsName = await renameAgent(oldName, newLabel);

  nl();
  ok(`ENS name successfully renamed to: ${c.bold(newEnsName)}`);
  persistEnv({
    BRAIN_ENS_NAME: newEnsName,
    BRAIN_ENS_LABEL: newLabel,
    BRAIN_ENS_MODE: "own"
  });
  out(TxLogger.summary());
  nl();
}

// ── COMMAND: ens resolve ──────────────────────────────────────────────────────

async function cmdEnsResolve(ensName: string, flags: Record<string, string | true>): Promise<void> {
  if (!ensName) { err("Usage: 0mcp ens resolve <ens-name>"); process.exit(1); }

  info(`Resolving ${ensName}…`);
  const { resolveBrain } = await import("./ens.js");
  const meta = await resolveBrain(ensName);

  if (hasFlag(flags, "json")) { jsonOut(meta); return; }

  header(`ENS RESOLVE — ${ensName}`);
  out(`    Name:         ${meta.name}`);
  out(`    Project:      ${meta.project_id}`);
  out(`    Description:  ${meta.description || c.dim("(not set)")}`);
  out(`    Sessions:     ${meta.sessions}`);
  out(`    Wallet:       ${meta.wallet ?? c.dim("(not set)")}`);
  out(`    Token ID:     ${meta.token_id != null ? String(meta.token_id) : c.dim("(not minted yet)")}`);
  out(`    Contract:     ${meta.contract_address ?? c.dim("(not set)")}`);
  nl();
}

// ── COMMAND: ens issue ────────────────────────────────────────────────────────

async function cmdEnsIssue(brainEns: string, renterAddr: string): Promise<void> {
  TxLogger.clear();
  if (!brainEns || !renterAddr) { err("Usage: 0mcp ens issue <brain-ens> <renter-addr>"); process.exit(1); }

  header("ENS RENTAL — ISSUE");
  info(`Brain:  ${brainEns}`);
  info(`Renter: ${renterAddr}`);
  nl();
  info("Creating rental subname on Sepolia (sponsored gas-free via Paymaster)…");

  const { issueRental } = await import("./ens.js");
  const subname = await issueRental(brainEns, renterAddr);

  nl();
  ok(`Rental issued: ${c.bold(subname)}`);
  nl();
  info("Renter can verify access with:");
  bull(`0mcp ens verify ${subname}`);
  out(TxLogger.summary());
  nl();
}

// ── COMMAND: ens verify ───────────────────────────────────────────────────────

async function cmdEnsVerify(subname: string, flags: Record<string, string | true>): Promise<void> {
  if (!subname) { err("Usage: 0mcp ens verify <subname>"); process.exit(1); }

  info(`Verifying access for ${subname}…`);
  const { verifyAccess } = await import("./ens.js");
  const result = await verifyAccess(subname);

  if (hasFlag(flags, "json")) { jsonOut(result); return; }

  header(`ENS VERIFY — ${subname}`);
  out(`    Valid:      ${result.valid ? c.green("yes") : c.red("no")}`);
  out(`    Subname:    ${result.subname}`);
  out(`    Renter:     ${result.renter || c.dim("(not set)")}`);
  out(`    Granted by: ${result.grantedBy || c.dim("(not set)")}`);
  out(`    Owner:      ${result.owner || c.dim("(not set)")}`);
  out(`    Expires:    ${result.expiresAt ? new Date(result.expiresAt).toISOString() : c.dim("(no expiry)")}`);
  nl();
  if (!result.valid) {
    warn("Access is NOT valid. Possible reasons:");
    bull("Subname not registered / no text records set");
    bull("Rental has expired");
    bull("ENS owner does not match renter address");
  } else {
    ok("Access is VALID — renter is authorised.");
  }
  nl();
}

// ── COMMAND: inft status ──────────────────────────────────────────────────────

async function cmdInftStatus(contractAddr: string, tokenId: string, flags: Record<string, string | true>): Promise<void> {
  if (!contractAddr || !tokenId) { err("Usage: 0mcp inft status <contract> <token-id>"); process.exit(1); }

  info(`Checking token #${tokenId} on ${contractAddr}…`);

  const rpcUrl = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const chainId = Number(process.env.ZG_CHAIN_ID ?? "16602");
  const abi = [
    "function tokenURI(uint256 tokenId) external view returns (string memory)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
  ];
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
  const contract = new ethers.Contract(contractAddr, abi, provider);

  const [uriRaw, owner] = await Promise.all([
    (contract.tokenURI as (id: bigint) => Promise<string>)(BigInt(tokenId)),
    (contract.ownerOf as (id: bigint) => Promise<string>)(BigInt(tokenId)).catch(() => "(not found)"),
  ]);

  // Decode if base64 data URI
  let decoded: unknown = null;
  const b64Match = uriRaw.match(/^data:application\/json;base64,(.+)$/);
  if (b64Match) {
    try { decoded = JSON.parse(Buffer.from(b64Match[1], "base64").toString("utf8")); }
    catch { /* leave null */ }
  }

  const result = {
    contract: contractAddr,
    token_id: tokenId,
    owner,
    uri_length: uriRaw.length,
    uri_format: b64Match ? "data:application/json;base64" : "raw",
    decoded_entry_count: decoded && typeof decoded === "object" && "entry_count" in decoded
      ? (decoded as { entry_count: number }).entry_count
      : null,
  };

  if (hasFlag(flags, "json")) { jsonOut(result); return; }

  header(`INFT STATUS — #${tokenId}`);
  out(`    Contract:    ${contractAddr}`);
  out(`    Token ID:    ${tokenId}`);
  out(`    Owner:       ${owner}`);
  out(`    URI format:  ${result.uri_format}`);
  out(`    URI length:  ${uriRaw.length} chars`);
  if (result.decoded_entry_count !== null) {
    out(`    Entries:     ${result.decoded_entry_count}`);
  }
  out(`    Explorer:    ${c.cyan(`https://chainscan-galileo.0g.ai/address/${contractAddr}`)}`);
  nl();
}

// ── COMMAND: demo ─────────────────────────────────────────────────────────────


// ── COMMAND: wallet status ────────────────────────────────────────────────────

async function cmdWalletStatus(flags: Record<string, string | true>): Promise<void> {
  let address = "";
  const pk = process.env.ZG_PRIVATE_KEY;
  if (pk) {
    address = new ethers.Wallet(pk).address;
  } else {
    err("ZG_PRIVATE_KEY not set in .env");
    return;
  }

  const zgRpc  = process.env.ZG_RPC_URL      ?? "https://evmrpc-testnet.0g.ai";
  const sepRpc = process.env.SEPOLIA_RPC_URL  ?? "https://ethereum-sepolia-rpc.publicnode.com";

  const zgChainId = Number(process.env.ZG_CHAIN_ID ?? "16602");
  const sepChainId = 11155111;

  const zgProvider  = new ethers.JsonRpcProvider(zgRpc, zgChainId, { staticNetwork: true as any });
  const sepProvider = new ethers.JsonRpcProvider(sepRpc, sepChainId, { staticNetwork: true as any });

  info(`Fetching status for ${address}…`);

  const { getPaymasterStatus, shouldUsePaymaster } = await import("./paymaster.js");
  
  // Helper to fetch balance with timeout and retry
  const fetchBalance = async (provider: ethers.Provider, addr: string, label: string) => {
    try {
      return await withRetry(
        () => Promise.race([
          provider.getBalance(addr),
          new Promise<bigint>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 10000))
        ]),
        2,
        1000
      );
    } catch (e) {
      warn(`Failed to fetch ${label} balance: ${e instanceof Error ? e.message : String(e)}`);
      return -1n;
    }
  };

  const [zgBal, sepBal, pmUse, pmStatus] = await Promise.all([
    fetchBalance(zgProvider, address, "0G"),
    fetchBalance(sepProvider, address, "Sepolia"),
    shouldUsePaymaster(address).catch(() => false),
    Promise.resolve(getPaymasterStatus()),
  ]);

  const dashboard = {
    address,
    network_0g:      { balance: ethers.formatEther(zgBal),  rpc: zgRpc },
    network_sepolia: { balance: ethers.formatEther(sepBal), rpc: sepRpc },
    config: {
      ens_parent:    process.env.ENS_PARENT_NAME      ?? "0mcp.eth",
      inft_contract: process.env.INFT_CONTRACT_ADDRESS ?? "(not set)",
    },
    paymaster: { ...pmStatus, sponsoring: pmUse },
  };

  if (hasFlag(flags, "json")) { jsonOut(dashboard); return; }

  header("0MCP WALLET DASHBOARD");
  out(`    Address:     ${c.green(address)}`);
  nl();
  out(c.bold("  Balances:"));
  
  const formatBal = (val: bigint, sym: string, label: string) => {
    if (val === 0n && pmStatus.configured) { // Might be error or 0
       // If we actually fetched 0n, it returns 0n. 
       // If it caught an error, it returns 0n but we should ideally know.
       // Let's refine fetchBalance to return null on error.
    }
    return ethers.formatEther(val);
  };

  out(`    ● 0G Galileo:  ${zgBal === -1n ? c.red("Fetch error") : c.cyan(ethers.formatEther(zgBal))} $OG`);
  out(`    ● Sepolia:     ${sepBal === -1n ? c.red("Fetch error") : c.magenta(ethers.formatEther(sepBal))} $ETH`);
  nl();
  out(c.bold("  Gas Sponsorship:"));
  if (pmStatus.configured) {
    out(`    ● Paymaster:   ${c.green(pmStatus.paymasterAddress)}`);
    out(`    ● Relay:       ${pmStatus.relayUrl}`);
    out(`    ● Sponsoring:  ${pmUse ? c.green("YES — your ENS ops are gas-free!") : c.yellow("No (you have Sepolia ETH, direct send)")}`);
  } else {
    out(`    ● Paymaster:   ${c.yellow("(not configured) — set PAYMASTER_ADDRESS in .env")}`);
    out(`    ● Sepolia ETH: ${Number(ethers.formatEther(sepBal)) < 0.005
      ? c.red("LOW — ENS ops need ~0.005 ETH or deploy paymaster")
      : c.green("sufficient")}`);
  }
  nl();
  out(c.bold("  Identity:"));
  out(`    ● Parent:      ${dashboard.config.ens_parent}`);
  const brainName  = process.env.BRAIN_ENS_NAME ?? "";
  const brainMode  = process.env.BRAIN_ENS_MODE ?? "";
  const brainLabel = brainMode === "own" ? c.cyan(brainName) + c.dim(" (yours)")
                   : brainMode === "loaded" ? c.magenta(brainName) + c.dim(" (imported)")
                   : brainName ? c.dim(brainName) : c.dim("(none set in .env)");
  out(`    ● Active Brain:${brainLabel}`);
  out(`    ● iNFT:        ${dashboard.config.inft_contract}`);
  out(`    ● Storage:     ${c.green("0G Galileo testnet")}`);
  out(`    ● Explorer:    ${c.cyan("https://storagescan-galileo.0g.ai")}`);
  nl();
  out(c.bold("  Tips:"));
  bull("Run `0mcp health` to verify network connectivity.");
  bull("Run `0mcp ens resolve <name>` to check your agent identity.");
  if (brainMode === "loaded") {
    bull(c.magenta(`Imported brain ${brainName} — you can use \`load_brain\` MCP tool to inject its context.`));
    bull(c.dim("To register your own brain, change BRAIN_ENS_LABEL in .env.0mcp and delete BRAIN_ENS_REGISTERED."));
  }
  if (!pmStatus.configured && Number(ethers.formatEther(sepBal)) < 0.005) {
    bull(c.yellow("Set PAYMASTER_ADDRESS in .env.0mcp to enable gas-free ENS ops using 0G tokens."));
  }
  nl();
}

// ── COMMAND: wallet send ──────────────────────────────────────────────────────

async function cmdWalletSend(asset: string, recipient: string, amount: string): Promise<void> {
  TxLogger.clear();
  const assetLow = asset.toLowerCase();
  if (!asset || !recipient || !amount || (assetLow !== "0g" && assetLow !== "eth")) {
    err("Usage: 0mcp wallet send [0g|eth] <recipient> <amount>");
    process.exit(1);
  }

  let rpcUrl = "";
  let pk = "";
  let symbol = "";
  let networkName = "";

  if (assetLow === "0g") {
    rpcUrl = process.env.ZG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    pk = process.env.ZG_PRIVATE_KEY ?? "";
    symbol = "0G";
    networkName = "0G Galileo";
  } else if (assetLow === "eth") {
    rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    pk = process.env.ENS_PRIVATE_KEY ?? process.env.ZG_PRIVATE_KEY ?? "";
    symbol = "ETH";
    networkName = "Sepolia";
  }

  if (!pk) {
    err(`Private key not found in .env for ${symbol}`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);

  info(`Sending ${amount} ${symbol} to ${recipient} on ${networkName}...`);
  try {
    const tx = await wallet.sendTransaction({
      to: recipient,
      value: ethers.parseEther(amount)
    });
    out(`    TX Hash: ${c.cyan(tx.hash)}`);
    info("Waiting for confirmation...");
    await tx.wait();
    ok(`Transaction confirmed! Successfully sent ${c.green(amount)} $${symbol}.`);
    out(TxLogger.summary());
  } catch (e) {
    err(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}



// ── MAIN ROUTER ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const { command, sub1, sub2, flags } = parsed;

  if (!command || command === "help" || hasFlag(flags, "help") || hasFlag(flags, "h")) {
    printHelp();
    return;
  }

  try {
    if (command === "keygen") {
      await cmdKeygen(flags);

    } else if (command === "start") {
      // Launch the MCP server. We use dynamic import to avoid 
      // starting the server logic during help/other commands.
      await import("./index.js");

    } else if (command === "init") {
      await cmdInit();

    } else if (command === "health") {
      await cmdHealth();

    } else if (command === "wallet" && sub1 === "status") {
      await cmdWalletStatus(flags);
      
    } else if (command === "wallet" && sub1 === "send") {
      await cmdWalletSend(sub2 || parsed.positional[2] || "", parsed.positional[3] || "", parsed.positional[4] || "");

    } else if (command === "wallet" && sub1 === "projects") {
      // Stub: in a real implementation this would query the on-chain registry
      header("PROJECTS INDEX");
      info("Retrieving project list from 0G Registry…");
      nl();
      warn("Scanning not yet supported by standard Registry contract.");
      bull("Use `0mcp memory list <project-id>` if you know the project ID.");
      nl();

    } else if (command === "memory" && sub1 === "list") {
      await cmdMemoryList(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "memory" && sub1 === "export") {
      await cmdMemoryExport(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "brain" && sub1 === "mint") {
      await cmdBrainMint(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "brain" && sub1 === "load") {
      await cmdBrainLoad(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "brain" && sub1 === "share") {
      await cmdBrainShare(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "brain" && sub1 === "status") {
      await cmdBrainStatus(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "ens" && sub1 === "register") {
      await cmdEnsRegister(sub2 || parsed.positional[2] || "", parsed.positional[3] || "", parsed.positional[4] || "");

    } else if (command === "ens" && sub1 === "rename") {
      await cmdEnsRename(sub2 || parsed.positional[2] || "", parsed.positional[3] || "");

    } else if (command === "ens" && sub1 === "resolve") {
      await cmdEnsResolve(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "ens" && sub1 === "issue") {
      await cmdEnsIssue(sub2 || parsed.positional[2] || "", parsed.positional[3] || "");

    } else if (command === "ens" && sub1 === "verify") {
      await cmdEnsVerify(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "inft" && sub1 === "status") {
      await cmdInftStatus(
        sub2 || parsed.positional[2] || "",
        parsed.positional[3] || "",
        flags
      );


    } else {
      err(`Unknown command: ${command} ${sub1}`);
      nl();
      printHelp();
      process.exit(1);
    }
  } catch (e) {
    nl();
    err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    if (process.env.DEBUG_CLI === "true" && e instanceof Error) {
      out(c.dim(e.stack ?? ""));
    }
    nl();
    process.exit(1);
  }
}

main();
