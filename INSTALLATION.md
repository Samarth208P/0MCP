# 0MCP — Installation Guide

Welcome to the 0MCP ecosystem. 0MCP gives any AI coding agent (Cursor, VS Code, Windsurf) **persistent memory** on the 0G decentralised network and an **ENS identity** on Ethereum — turning sessions into compounding expertise.

## Prerequisites
Before you begin, ensure you have the following installed:
- **Node.js 18+** (LTS recommended)
- **Git** (for cloning extensions, the P2P layer, and the **repo auto-ingestion** feature — must be on `PATH`)
- **Go 1.25.5+** (Required to build the AXL P2P node binary)

> **Auto-Ingestion note:** The `0mcp ingest repo` command shells out to `git` to read commit history. Git must be available on your system `PATH`. On Windows, Git for Windows (or Git shipped with VS Code) satisfies this requirement.

---

## Step 1: Install & Initialise (2 minutes)

Open your project directory in a terminal and run:

```bash
npm install -g @samarth208p/0mcp@latest
0mcp init
```

The wizard will:

- Generate (or import) an Ethereum keypair
- Scaffold a `.env.0mcp` file with all required settings pre-filled
- Ask for your desired **Brain name** (e.g. `sampy` → `sampy.0mcp.eth`)

> **Your brain name is automatically registered to your wallet** the first time you connect your IDE — no extra steps.

---

## Step 2: Get Testnet Tokens

Your wallet needs tokens on two networks:

| Token | Purpose | Faucet |
|---|---|---|
| **0G (Galileo)** | Memory storage writes | <https://faucet.0g.ai> |
| **Sepolia ETH** | ENS registration gas (or use the built-in paymaster) | <https://sepoliafaucet.com> |

> The built-in **ZeroG Paymaster** (`PAYMASTER_ADDRESS` in `.env.0mcp`) can sponsor ENS gas if you have 0G tokens — so Sepolia ETH is optional.

---

## Step 3: Connect your IDE

Choose your IDE and add the 0MCP server exactly as shown.

### Cursor / VS Code / Codex Extension

1. Go to your IDE's MCP Settings (e.g., **Cursor Settings** → **Features** → **MCP**)
2. Click **+ Add new MCP server**
3. Set **Type** to `stdio`, **Name** to `0mcp`
4. Set the **Command** to:

   ```bash
   npx.cmd -y @samarth208p/0mcp@latest start
   ```

   > On **Mac/Linux** use `npx`. On **Windows** you **must** use `npx.cmd`.
5. Click **Save** — the indicator should turn green immediately.

---

### Antigravity / Cline / Roo / Continue.dev

For AI agents and extensions that use a JSON configuration file (such as Antigravity's `mcp_config.json`), insert the following into your `mcpServers` block:

```json
{
  "mcpServers": {
    "0mcp": {
      "command": "npx.cmd",
      "args": ["-y", "@samarth208p/0mcp@latest", "start"],
      "disabled": false
    }
  }
}
```

> **Note:** On Mac/Linux, remember to change `"command": "npx.cmd"` to `"command": "npx"`.

Save the configuration file. The server will restart automatically or when you reload your IDE.

---

## Step 4: Configure the AI System Prompt (Project Rules)

To ensure the AI autonomously uses the memory layer, you must add the **0MCP Agent Instructions** to your IDE's project rules or system prompt.

### Antigravity

1. Open the **Antigravity** interface in your project.
2. Look for the **Rules** or **Context** section (or click the `+` icon in the rules view).
3. Paste the following block into your **Project Rules**:

### Cursor / VS Code

Create a file called **`.cursorrules`** (Cursor) or **`.vscode/instructions.md`** (VS Code) in your project root with this content:

---

### 0MCP Agent Instructions (Copy & Paste)

```markdown
# 0MCP Agent Instructions

You are a 0MCP-integrated persistent agent. Follow these rules for EVERY prompt.

> Tools may be prefixed (e.g. `mcp_0mcp_get_context`). Check your available tools list.

## 1. PRE-FLIGHT (MANDATORY)
At the start of EVERY session, call `get_context` BEFORE answering.
Never assume you know the project rules — your memory lives on 0G.

## 2. POST-FLIGHT SAVE (AUTONOMOUS MEMORY)
After EVERY meaningful exchange (new rule, bug pattern, decision), call `save_memory`.
Do NOT wait for the user to say "remember this". This is your autonomous duty.

## 3. IDENTITY & FUNDS
- ENS registration: use `register_agent`
- Sending tokens: use `send_funds` (always confirm amount + address with user first)
- Export knowledge: use `mint_brain` to create a portable Brain iNFT

## 4. SECURITY
- ALWAYS ensure `.env.0mcp` is added to the project's `.gitignore` file immediately. Do this autonomously to prevent accidental leakage of the user's private keys.

## 5. AXL P2P SETUP (AUTONOMOUS)
- Autonomously configure the P2P mesh if discovery or cross-agent features are needed but AXL is missing:
  1. **Clone**: `git clone https://github.com/gensyn-ai/axl.git`
  2. **Build**: Use `GOTOOLCHAIN=go1.25.5` to build: `cd axl && go build -o node.exe ./cmd/node/`
  3. **Identity**: If `axl/private.pem` is missing, generate an Ed25519 PKCS8 key first.
  4. **Config**: Update `axl/node-config.json` with the **absolute path** to `private.pem`.
  5. **Register**: `0mcp axl setup <absolute-path-to-node.exe>`
  6. **Initialize**: `0mcp axl init` to finalize the mesh identity.
```

---

## Step 5: Verify It Works

Open your AI chat and test these prompts:

1. **Memory save:** *"Set a rule that our primary colour is #FF0000. Save it to memory."*
2. **Memory recall:** *"What colour rules do we have?"* (should retrieve the saved rule)
3. **Brain check:** *"What is my brain ENS name?"* (should see `yourname.0mcp.eth`)

---

## AI / LLM Operator Playbook (Recommended)

If you're an AI coding agent (Cursor/VS Code/Cline/etc.) or you're evaluating 0MCP end-to-end, use this section to avoid common pitfalls and to validate the full “happy path” like a real user.

### Security rules (MANDATORY)

- **Never paste or print private keys** in chat logs, issues, PRs, screenshots, or terminal output copied into chat.
- **Avoid running `0mcp keygen` during evaluations** unless you are in a fully local/private terminal session. It prints a private key + mnemonic to the terminal output.
- Ensure `.env.0mcp` is ignored by git (and never committed). This repo already intends that, but double-check your own project’s ignore rules.

### Working directory rule (Windows gotcha)

When using the built artifacts locally, run commands from the **repo root**:

```bash
node build/src/cli.js help
node build/src/cli.js start
```

If you run the same command from inside `build/`, Node may look for `build/build/src/cli.js` and fail.

### Safe CLI “smoke tests” (no on-chain writes)

These should succeed even without funds:

```bash
0mcp help
0mcp health
0mcp wallet status --json
0mcp memory list <project-id> --json
0mcp inft status <contract> <token-id> --json
0mcp ens verify <subname> --json
```

### Full end-user “happy path” validation (does on-chain writes)

This flow validates **0G storage + iNFT mint + ENS registration + brain load**.

1. **Create at least one memory entry** (via your IDE using MCP tools, or any integration that calls `save_memory`).
2. **Export snapshot**

```bash
0mcp memory export <project-id> --file build/_snapshot.json
```

3. **Mint iNFT**

```bash
0mcp brain mint <project-id> --recipient <0x-wallet>
```

4. **Register ENS for the minted brain** (recommended: pass the token id)

```bash
0mcp ens register <project-id> <label> <token-id>
```

5. **Resolve + load by ENS**

```bash
0mcp ens resolve <label>.0mcp.eth --json
0mcp brain load <label>.0mcp.eth --into <project-id>
```

### AXL mesh: end-user setup + verification

AXL is the P2P layer. A working setup is validated by:
- `0mcp axl init` succeeds and saves your unique Peer Key to `.env.0mcp`.
- You can query the local API at `http://127.0.0.1:9002/topology`.
- `0mcp ens register ...` publishes your peer key to ENS (text record `com.0mcp.axl.peer`).
- `0mcp mesh discover` returns discoverable peers from the registrar.

Technical Build & Launch Flow:

```powershell
# 1. Build binary (Go 1.25.5 required)
# Override toolchain to match gvisor dependency requirements
$env:GOTOOLCHAIN="go1.25.5"
cd axl
go build -o node.exe ./cmd/node/

# 2. Register path with 0MCP
0mcp axl setup .\axl\node.exe

# 3. Configure Node Paths
# Use an ABSOLUTE path for PrivateKeyPath in axl/node-config.json
# Ensure the private key is in Ed25519 PKCS8 format.

# 4. Boot & Init Mesh Identity
0mcp axl init

# 5. Launch persistent server
.\axl\node.exe -config .\axl\node-config.json
```

---

## Step 6: Join the P2P Intelligence Mesh (Optional)

0MCP allows you to request another agent's memory by ENS, discover peers from the registrar-backed index, or merge multiple brains into a single **Super-Brain**.

1.  **Clone & Build the AXL Binary:**
    The P2P layer is powered by **Gensyn AXL**.
    ```powershell
    git clone https://github.com/gensyn-ai/axl.git
    cd axl
    # Force Go 1.25.5 toolchain to resolve gvisor dependency conflicts
    $env:GOTOOLCHAIN="go1.25.5"
    go build -o node.exe ./cmd/node/
    ```

2.  **Register the Path with 0MCP:**
    ```powershell
    0mcp axl setup .\axl\node.exe
    ```

3.  **Configure Node Identity (Absolute Paths):**
    Open `axl/node-config.json` and set `PrivateKeyPath` to the **absolute path** of your `private.pem` (e.g., `C:\PC\Codes\0MCP\axl\private.pem`).
    
    > **Note:** If `private.pem` is missing, you must generate a secure Ed25519 private key in PKCS8 format. The node requires this identity to sign P2P messages.

4.  **Initialize Mesh Identity:**
    ```powershell
    0mcp axl init
    ```
    This generates your unique Peer Key and saves it to your `.env.0mcp`.

5.  **Launch the Background Server:**
    ```powershell
    .\axl\node.exe -config .\axl\node-config.json
    ```
    The node will open the API on port `9002` and the P2P listener on port `7000`.

6.  **Request and Trade:**
    ```powershell
    0mcp mesh discover --keyword smart-contracts
    0mcp mesh request expert.0mcp.eth --into my-project
    ```

---

## CLI Reference

```text
0mcp <command> [subcommand] [options]
0mcp start                       Launch the MCP server (for use in IDEs)

SETUP
  init                             Interactive setup wizard — generates keys + scaffolds .env.0mcp
  health                           Check 0G RPC, indexer, registry, ENS Sepolia

WALLET & FUNDS
  wallet status [--json]           Show balances, brain identity, paymaster status
  wallet send <asset> <addr> <amt> Send 0G or ETH to another address (asset: 0g or eth)
  keygen [--save]                  Generate Ethereum keypair (safe offline)

MEMORY
  memory list <project> [--json] [--include-ingest]  List saved memory entries
  memory export <project>          Export full snapshot JSON to stdout or file
  memory health <project> [--json] [--trend]          Show memory health dashboard

INGESTION (auto-learn from repo)
  ingest repo [--project <id>] [--path <dir>] [--dry-run]         Ingest full git history
  ingest commits [--since <ref>] [--project <id>] [--path <dir>]  Ingest commits since ref

BRAIN
  brain mint <project>             Mint Brain iNFT + register ENS in one step
  brain load <ens-name> --into     Load external Brain into local project
  brain merge <e1> <e2> --output   Merge two brains into a new Super-Brain
  brain share <project> [--json]   Show ENS name + token ID
  brain status <project> [--json]  Show token, contract, entry count

AXL MESH (P2P)
  axl setup <path>                 Save the path to the AXL binary
  axl init                         Generate peer key and update .env
  mesh discover [--keyword <tag>] [--limit <n>] Scan the registrar-backed peer index
  mesh request <ens> --into <p>    Buy + load a brain's memory via escrow
  mesh set-price <amount>          Set your brain's listing price (in OG)

ENS
  ens register <project> <label>   Register <label>.0mcp.eth subname
  ens rename <old> <new-label>     Rename an existing Brain ENS name
  ens resolve <ens-name> [--json]  Resolve ENS → metadata JSON
  ens issue <brain> <renter>       Issue a rental subname
  ens verify <subname> [--json]    Verify rental access

INFT
  inft status <contract> <tokenId> Check tokenURI on 0G testnet

FLAGS
  --json             Output raw JSON (all read commands)
  --save             Persist generated keys to .env.0mcp
  --file             Write output to file instead of stdout
  --include-ingest   Show auto-ingested git entries in memory list
  --dry-run          Preview ingestion without writing to storage
  --trend            Show health history trend (memory health command)
  --help             Show this help screen
```

---

---

## Advanced Configuration (.env.0mcp)

| Variable | Description |
|---|---|
| `MESH_ESCROW_ADDRESS` | Address of the Brain Escrow contract on 0G Galileo. |
| `MERGE_REGISTRY_ADDRESS` | Address of the Merge Registry contract on 0G Galileo. |
| `AXL_BINARY_PATH` | Path to the `axl` executable. |
| `AXL_PRIVATE_KEY` | Private key used for signing P2P mesh messages. |
| `MESH_EXPERTISE` | Comma-separated tags published to ENS for mesh discovery (for example `solidity,smart-contracts`). |
| `DISCOVERY_LOOKBACK_DAYS` | How many recent days of registrar logs to scan when `DISCOVERY_START_BLOCK` is unset (default `2`). |
| `DISCOVERY_START_BLOCK` | Explicit lower bound for registrar log scanning if you want to pin a known deployment block. |
| `BRAIN_ENS_NAME` | Your agent's primary ENS name (e.g., `agent.0mcp.eth`). |

---

## Ingestion & Health (v3.1+)

### Repo Auto-Ingestion

Tell 0MCP to learn from your git history automatically:

```bash
# Ingest the last 50 commits (default)
0mcp ingest repo --project my-project

# Ingest only commits since a specific ref or date
0mcp ingest commits --since HEAD~20 --project my-project

# Preview what would be ingested without writing (dry run)
0mcp ingest repo --project my-project --dry-run

# View ingested entries
0mcp memory list my-project --include-ingest
```

Ingested entries are deduplicated automatically. Commit hashes are tracked in `.0mcp-ingest-state.json` (safe to `.gitignore`).

### Memory Health Dashboard

```bash
# Human-readable health report
0mcp memory health my-project

# Machine-readable JSON (for CI scripts)
0mcp memory health my-project --json

# View trend over last 7 snapshots
0mcp memory health my-project --trend
```

Health snapshots are stored locally in `.0mcp-health-history.json`.

### Drift Detection

Drift detection runs automatically on every `get_context` call. When a new prompt conflicts with past decisions, a `=== DRIFT WARNINGS ===` block is appended to the context.

You can also check drift explicitly:
- **CLI**: integrated into `get_context` output automatically
- **MCP tool**: `check_drift(project_id, prompt)` returns structured findings

---

## Troubleshooting

### MCP server not appearing in IDE

- Make sure you ran `0mcp init` first in the project directory
- Confirm the command uses `npx.cmd` on Windows (not `npx`)
- Try `0mcp health` to verify connectivity

### ENS registration fails

- Check `0mcp wallet status` — ensure you have Sepolia ETH **or** the paymaster is configured
- Run `0mcp ens register <project> <label>` manually to retry

### AXL node fails to start

- Ensure the `axl` binary is executable (`chmod +x axl` on Linux/Mac)
- Check that the port `9002` is not blocked or in use
- Run `0mcp axl init` to verify connectivity

### Brain name already taken

- The server detects this automatically and loads it as an **imported** brain
- To register your own, change `BRAIN_ENS_LABEL` in `.env.0mcp` to a different name, then delete `BRAIN_ENS_REGISTERED=`

### Memory not persisting

- Run `0mcp health` to check 0G indexer connectivity
- Confirm `ZG_PRIVATE_KEY` and `MEMORY_REGISTRY_ADDRESS` are set in `.env.0mcp`
- Check that your wallet has 0G tokens (needed for storage writes): <https://faucet.0g.ai>
