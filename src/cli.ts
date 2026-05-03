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
import { discoverMeshPeers } from "./discovery.js";
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
  let content = "";
  
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf8");
  } else {
    content = "# 0MCP Environment Configuration\n";
  }

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  fs.writeFileSync(envPath, content);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveAxlBinaryPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Allow `axl` to mean "use whatever is on PATH" without forcing a filesystem check.
  if (trimmed === "axl") return trimmed;

  const resolved = path.resolve(trimmed);
  const candidates = new Set<string>([resolved]);

  // On Windows, users often point at a build output without the extension.
  if (process.platform === "win32") {
    candidates.add(`${resolved}.exe`);
    candidates.add(`${resolved}.cmd`);
  }

  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  // If the caller passed a directory, try common build outputs inside it.
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const dirCandidates = process.platform === "win32"
      ? ["node.exe", "node", "axl.exe", "axl"]
      : ["node", "axl"];
    for (const name of dirCandidates) {
      const candidate = path.join(resolved, name);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    `AXL binary not found at ${resolved}. Build the binary first, then run ` +
    `0mcp axl setup with the real executable path (for example: ./axl/node.exe).`
  );
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
  row("keygen [--save]",                            "Generate Ethereum keypair (safe offline)");
  out("");
  out(c.bold("  MEMORY"));
  row("memory list <project-id> [--json] [--include-ingest]", "List saved memory entries");
  row("memory export <project-id> [--file <path>]",           "Export full snapshot JSON");
  row("memory health <project-id> [--json] [--trend]",        "Show memory health dashboard");
  out("");
  out(c.bold("  INGESTION"));
  row("ingest repo [--project <id>] [--path <dir>] [--dry-run]",           "Ingest git history into memory");
  row("ingest commits [--since <ref>] [--project <id>] [--path <dir>]",    "Ingest commits since a ref/date");
  out("");
  out(c.bold("  BRAIN"));
  row("brain mint <project-id> [--recipient <addr>] [--ens <label>]", "Mint Brain iNFT + register ENS in one step");
  row("brain load <ens-name> --into <project-id>",     "Load external Brain into local project");
  row("brain merge <ens1> <ens2> --output <label>",    "Merge two brains into a new Super-Brain");
  row("brain share <project-id> [--json]",             "Show ENS name + token ID");
  row("brain status <project-id> [--json]",            "Show token, contract, entry count");
  out("");
  out(c.bold("  AXL MESH"));
  row("axl setup <path-to-binary>",                 "Save the path to the downloaded AXL binary");
  row("axl init",                                   "Fetch & display your AXL peer key, write to .env");
  row("mesh discover [--keyword <tag>] [--limit <n>]", "Scan the registrar-backed peer index and show peers");
  row("mesh request <ens-name> --into <proj>",      "Buy + load a brain's memory (full payment flow)");
  row("mesh set-price <amount-in-og>",              "Set your brain's listing price on ENS");
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
  out(`    ${c.cyan("--json")}            Output raw JSON (all read commands)`);
  out(`    ${c.cyan("--save")}            Persist generated keys to .env`);
  out(`    ${c.cyan("--file")}            Write output to file instead of stdout`);
  out(`    ${c.cyan("--include-ingest")}  Show auto-ingested entries in memory list`);
  out(`    ${c.cyan("--dry-run")}         Preview ingestion without writing to storage`);
  out(`    ${c.cyan("--trend")}           Show health history trend`);
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
    persistEnv({ 
      ZG_PRIVATE_KEY: privateKey,
      AXL_PRIVATE_KEY: privateKey
    });
    ok("Keys saved to .env.0mcp (ZG_PRIVATE_KEY, AXL_PRIVATE_KEY)");
  }
}

// ── COMMAND: init ─────────────────────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  header("0MCP INIT");
  info("Generates your .env.0mcp in 4 questions.");
  nl();

  const { ethers } = await import("ethers");

  let privateKey = await prompt("Your Private Key (leave empty to generate a new one)", "");
  let address = "";
  if (!privateKey) {
    const wallet = ethers.Wallet.createRandom();
    privateKey = wallet.privateKey;
    address = wallet.address;
    ok(`Generated new wallet: ${c.green(address)}`);
    warn("Save your private key safely — not shown again.");
    nl();
  } else {
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

  const currentFolder = path.basename(process.cwd());
  const project_id = await prompt("Project ID", currentFolder);

  const { saveProjectLocation } = await import("./registry.js");
  saveProjectLocation(project_id, process.cwd());

  const brainLabel = await prompt(`Brain ENS label (e.g. 'myagent' → myagent.0mcp.eth)`, "");

  const envContent = `# 0MCP Environment — generated by 0mcp init
# DO NOT commit this file to git.

PROJECT_ID=${project_id}
ZG_PRIVATE_KEY=${privateKey}
AXL_PRIVATE_KEY=${privateKey}
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
  const allEntries = await loadAllEntries(project);

  // Filter out __ingest__ entries unless --include-ingest is passed
  const includeIngest = hasFlag(flags, "include-ingest");
  const entries = includeIngest
    ? allEntries
    : allEntries.filter((e) => !e.tags.some((t) => t.startsWith("__ingest__")));

  if (hasFlag(flags, "json")) {
    jsonOut(entries);
    return;
  }

  header(`MEMORY — ${project}`);
  if (allEntries.length === 0) {
    warn(`No memory entries found for project: ${project}`);
    return;
  }

  const ingestCount = allEntries.length - entries.length;
  out(c.bold(`  ${entries.length} entries`) + (ingestCount > 0 ? c.dim(` (${ingestCount} auto-ingested hidden — use --include-ingest)`) : ""));
  nl();
  for (const [i, e] of entries.entries()) {
    const isIngest = e.tags.some((t) => t.startsWith("__ingest__"));
    out(`  ${c.cyan(`[${i + 1}]`)} ${c.dim(new Date(e.timestamp).toISOString())}${isIngest ? c.dim(" [ingested]") : ""}`);
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
            const lookup = await lookupPrimaryBrain(address);
            let targetName = lookup || "";
            if (!targetName || !targetName.includes(chosen.projectId.toLowerCase())) {
               targetName = await prompt(`Enter ENS name for ${chosen.projectId} to load (e.g. name.0mcp.eth)`, `${chosen.projectId.toLowerCase()}.0mcp.eth`);
            }
            
            await cmdBrainLoad(targetName, { into: project });
          }
        }
      }
    } catch { /* optional scan only */ }
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



// ── COMMAND: ingest repo / ingest commits ────────────────────────────────────

async function cmdIngest(
  sub: string,
  flags: Record<string, string | true>
): Promise<void> {
  const projectId = (flag(flags, "project") ?? process.env.PROJECT_ID ?? "").trim();
  if (!projectId) {
    err("Project ID required. Use --project <id> or set PROJECT_ID in .env");
    process.exit(1);
  }

  const repoPath = path.resolve(flag(flags, "path") ?? process.cwd());
  const since = flag(flags, "since");
  const dryRun = hasFlag(flags, "dry-run");
  const maxCommits = flag(flags, "max-commits") ? Number(flag(flags, "max-commits")) : 50;

  if (sub === "commits" && !since) {
    warn("No --since ref provided. Reading last 50 commits by default.");
  }

  header(sub === "commits" ? "INGEST COMMITS" : "INGEST REPO");
  info(`Project:   ${projectId}`);
  info(`Repo path: ${repoPath}`);
  if (since) info(`Since ref: ${since}`);
  if (dryRun) warn("DRY RUN — no data will be written to storage.");
  nl();

  const { runIngestion } = await import("./ingest.js");

  info("Reading git history…");
  let result;
  try {
    result = await runIngestion(projectId, repoPath, { since, maxCommits, dryRun });
  } catch (e) {
    err(`Ingestion failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  nl();
  ok(`Ingestion complete`);
  out(`    Commits read:  ${result.events.length}`);
  out(`    New events:    ${result.events.length - result.skipped}`);
  out(`    Skipped (dup): ${result.skipped}`);
  out(`    Entries saved: ${dryRun ? c.yellow("0 (dry run)") : c.green(String(result.saved))}`);
  nl();

  if (result.new_entries.length > 0) {
    info("Sample entries:");
    result.new_entries.slice(0, 3).forEach((e, i) => {
      out(`  ${c.cyan(`[${i + 1}]`)} ${e.prompt.split("\n")[0].slice(0, 80)}`);
    });
    nl();
  }

  if (!dryRun && result.saved > 0) {
    ok(`Saved to 0G storage. Run '0mcp memory list ${projectId} --include-ingest' to view.`);
  }
}

// ── COMMAND: memory health ────────────────────────────────────────────────────

async function cmdMemoryHealth(
  project: string,
  flags: Record<string, string | true>
): Promise<void> {
  const projectId = (project || flag(flags, "project") || process.env.PROJECT_ID || "").trim();
  if (!projectId) {
    err("Project ID required. Use: 0mcp memory health <project-id>");
    process.exit(1);
  }

  const { generateHealthReport, formatHealthReport, loadHealthHistory, formatHealthTrend } =
    await import("./health.js");

  const dashMode = (process.env.HEALTH_DASHBOARD_MODE ?? "full") as "full" | "compact";

  if (hasFlag(flags, "trend")) {
    header(`MEMORY HEALTH TREND — ${projectId}`);
    const history = loadHealthHistory(process.cwd(), 7);
    out(formatHealthTrend(history, c));
    return;
  }

  info(`Generating health report for: ${projectId}…`);
  nl();

  const report = await generateHealthReport(projectId, true, process.cwd());

  if (hasFlag(flags, "json")) {
    out(JSON.stringify(report, null, 2));
    return;
  }

  header(`MEMORY HEALTH — ${projectId}`);
  out(formatHealthReport(report, { mode: dashMode, colors: c }));

  if (!hasFlag(flags, "json")) {
    info(`Tip: Run with --json for machine-readable output, --trend for history.`);
    nl();
  }
}

// ── COMMAND: axl setup ────────────────────────────────────────────────────────

async function cmdAxlSetup(path: string): Promise<void> {
  if (!path) { err("Usage: 0mcp axl setup <path-to-binary>"); process.exit(1); }
  try {
    const binaryPath = resolveAxlBinaryPath(path);
    persistEnv({ AXL_BINARY_PATH: binaryPath });
    ok(`AXL binary path saved: ${binaryPath}`);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// ── COMMAND: axl init ─────────────────────────────────────────────────────────

async function cmdAxlInit(): Promise<void> {
  header("AXL MESH INIT");
  
  const binaryPath = process.env.AXL_BINARY_PATH || "";
  const axlDir = binaryPath ? path.dirname(binaryPath) : path.resolve(process.cwd(), "axl");
  const keyPath = path.join(axlDir, "private.pem");

  if (!process.env.ZG_PRIVATE_KEY) {
    // 1. Try to import from private.pem if it exists
    if (fs.existsSync(keyPath)) {
      info(`Found existing AXL private key at: ${keyPath}`);
      const confirm = await prompt("Import this key into .env.0mcp? (y/n)", "y");
      if (confirm.toLowerCase() === "y") {
        try {
          const pem = fs.readFileSync(keyPath, "utf8");
          const b64 = pem
            .replace(/-----BEGIN PRIVATE KEY-----/g, "")
            .replace(/-----END PRIVATE KEY-----/g, "")
            .replace(/\s/g, "");
          const pkcs8 = Buffer.from(b64, "base64");
          // Ed25519 PKCS8 prefix is 16 bytes: 302e020100300506032b657004220420
          const rawKey = pkcs8.slice(16).toString("hex");
          const pk = "0x" + rawKey;
          
          persistEnv({ ZG_PRIVATE_KEY: pk, AXL_PRIVATE_KEY: pk });
          process.env.ZG_PRIVATE_KEY = pk;
          process.env.AXL_PRIVATE_KEY = pk;
          ok("Private keys successfully imported from private.pem into .env.0mcp.");
        } catch (e) {
          warn(`Failed to import key from PEM: ${e}. Falling back to prompt.`);
        }
      }
    }
  }

  if (!process.env.ZG_PRIVATE_KEY) {
    warn("ZG_PRIVATE_KEY not found in environment.");
    const pk = await prompt("Enter your Private Key to enable mesh signing", "");
    if (pk) {
      persistEnv({ ZG_PRIVATE_KEY: pk, AXL_PRIVATE_KEY: pk });
      process.env.ZG_PRIVATE_KEY = pk;
      process.env.AXL_PRIVATE_KEY = pk;
      ok("Private keys saved to .env.0mcp");
    } else {
      err("Private key is required for AXL initialization.");
      process.exit(1);
    }
  }

  info("Starting AXL node to fetch peer key...");
  const { startAxlNode, getLocalPeerKey, stopAxlNode } = await import("./axl.js");
  try {
    await startAxlNode();
    const peerKey = await getLocalPeerKey();
    persistEnv({ AXL_PEER_KEY: peerKey });
    ok(`AXL initialized. Your Peer Key is: ${c.bold(peerKey)}`);
  } catch(e) {
    err(`Failed to initialize AXL: ${e}`);
  } finally {
    stopAxlNode();
  }
}

// ── COMMAND: mesh discover ────────────────────────────────────────────────────

async function cmdMeshDiscover(flags: Record<string, string | true>): Promise<void> {
  const keyword = flag(flags, "keyword");
  const limitRaw = flag(flags, "limit");
  const parsedLimit = limitRaw ? Number(limitRaw) : 20;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 20;
  const json = hasFlag(flags, "json");

  if (!json) {
    info(`Scanning the peer index${keyword ? ` for '${keyword}'` : ""}...`);
  }
  const peers = await discoverMeshPeers({ keyword: keyword || undefined, limit });

  if (json) {
    jsonOut(peers);
    return;
  }

  header("MESH DISCOVERY");
  if (peers.length === 0) {
    warn("No peers found in the registrar-backed index.");
    return;
  }

  out(c.bold(`  ${peers.length} peer${peers.length === 1 ? "" : "s"} found`));
  nl();
  for (const peer of peers) {
    out(`  ${c.cyan(peer.ens_name)}`);
    out(`      Label:    ${peer.label}`);
    out(`      Owner:    ${peer.owner_address}`);
    out(`      Project:  ${peer.project_id}`);
    out(`      PeerKey:  ${c.dim(peer.axl_peer_key)}`);
    out(`      Price:    ${c.green(peer.price_og)} $OG`);
    out(`      Tags:     ${peer.expertise.length ? peer.expertise.join(", ") : c.dim("none")}`);
    if (peer.description) out(`      Bio:      ${peer.description}`);
    nl();
  }
}

// ── COMMAND: mesh request ─────────────────────────────────────────────────────

async function cmdMeshRequest(ensName: string, flags: Record<string, string | true>): Promise<void> {
  if (!ensName) { err("Usage: 0mcp mesh request <ens-name> --into <project-id>"); process.exit(1); }
  const intoProject = flag(flags, "into");
  if (!intoProject) { err("--into <project-id> is required"); process.exit(1); }
  
  info(`Requesting brain from ${ensName}...`);
  const { discoverPeers, startAxlNode } = await import("./axl.js");
  const { requestBrainMemory } = await import("./exchange.js");
  
  const peers = await discoverPeers([ensName]);
  if (peers.length === 0) {
    err(`Could not resolve AXL peer key for ${ensName}`);
    process.exit(1);
  }
  
  await startAxlNode();
  try {
    await requestBrainMemory(ensName, peers[0].axl_peer_key, intoProject);
    ok(`Successfully requested and imported brain ${ensName}`);
  } catch(e) {
    err(`Request failed: ${e}`);
  }
}

// ── COMMAND: mesh set-price ───────────────────────────────────────────────────

async function cmdMeshSetPrice(price: string): Promise<void> {
  if (!price) { err("Usage: 0mcp mesh set-price <amount-in-og>"); process.exit(1); }
  persistEnv({ MESH_PRICE_OG: price });
  ok(`Price set to ${price} $OG. Run '0mcp ens register' to publish it.`);
}

// ── COMMAND: brain merge ──────────────────────────────────────────────────────

async function cmdBrainMerge(ensA: string, ensB: string, flags: Record<string, string | true>): Promise<void> {
  if (!ensA || !ensB) { err("Usage: 0mcp brain merge <ens1> <ens2> --output <label>"); process.exit(1); }
  const output = flag(flags, "output");
  if (!output) { err("--output <label> is required"); process.exit(1); }
  
  const criteria = flag(flags, "criteria");
  const criteriaTags = criteria ? criteria.split(",").map(s => s.trim()) : [];
  
  info(`Merging ${ensA} and ${ensB} into ${output}.0mcp.eth...`);
  const { mergeBrains } = await import("./merger.js");
  
  try {
    const res = await mergeBrains(ensA, ensB, output, { criteriaTags });
    ok(`Merge complete!`);
    out(`    Entries: ${res.synthetic_snapshot.entry_count}`);
    out(`    Copies:  ${res.token_ids.length}`);
  } catch(e) {
    err(`Merge failed: ${e}`);
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
      await import("./index.js");

    } else if (command === "init") {
      await cmdInit();

    } else if (command === "health") {
      await cmdHealth();

    } else if (command === "wallet" && sub1 === "status") {
      await cmdWalletStatus(flags);
      
    } else if (command === "wallet" && sub1 === "send") {
      await cmdWalletSend(sub2 || parsed.positional[2] || "", parsed.positional[3] || "", parsed.positional[4] || "");

    } else if (command === "memory" && sub1 === "list") {
      await cmdMemoryList(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "memory" && sub1 === "export") {
      await cmdMemoryExport(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "memory" && sub1 === "health") {
      await cmdMemoryHealth(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "ingest" && (sub1 === "repo" || sub1 === "commits")) {
      await cmdIngest(sub1, flags);

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

    } else if (command === "axl" && sub1 === "setup") {
      await cmdAxlSetup(sub2 || parsed.positional[2] || "");

    } else if (command === "axl" && sub1 === "init") {
      await cmdAxlInit();

    } else if (command === "mesh" && sub1 === "discover") {
      await cmdMeshDiscover(flags);

    } else if (command === "mesh" && sub1 === "request") {
      await cmdMeshRequest(sub2 || parsed.positional[2] || "", flags);

    } else if (command === "mesh" && sub1 === "set-price") {
      await cmdMeshSetPrice(sub2 || parsed.positional[2] || "");

    } else if (command === "brain" && sub1 === "merge") {
      await cmdBrainMerge(sub2 || parsed.positional[2] || "", parsed.positional[3] || "", flags);

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
