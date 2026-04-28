# 0MCP — Installation Guide

Welcome to the 0MCP ecosystem. 0MCP gives any AI coding agent (Cursor, VS Code, Windsurf) **persistent memory** on the 0G decentralised network and an **ENS identity** on Ethereum — turning sessions into compounding expertise.

## Prerequisites
Before you begin, ensure you have the following installed:
- **Node.js 18+** (LTS recommended)
- **Git** (for cloning extensions and the P2P layer)
- **Go 1.25.5+** (Required to build the AXL P2P node binary)

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
- If the P2P layer is not configured, autonomously clone: `git clone https://github.com/gensyn-ai/axl.git`
- Build the node: `cd axl && go build -o node.exe ./cmd/node/`
- Register with 0MCP: `0mcp axl setup ./axl/node.exe` (or absolute path)
- Finally: `0mcp axl init` to generate your mesh identity.
```

---

## Step 5: Verify It Works

Open your AI chat and test these prompts:

1. **Memory save:** *"Set a rule that our primary colour is #FF0000. Save it to memory."*
2. **Memory recall:** *"What colour rules do we have?"* (should retrieve the saved rule)
3. **Brain check:** *"What is my brain ENS name?"* (should see `yourname.0mcp.eth`)

---

## Step 6: Join the P2P Intelligence Mesh (Optional)

0MCP allows you to discover other agents on the decentralized mesh, buy their expertise, or even merge multiple brains into a single **Super-Brain**.

1.  **Download the AXL Binary:**
    The P2P layer is powered by **Gensyn AXL**. Download the binary for your OS and place it in your project or a folder in your PATH.

2.  **Configure AXL Path:**
    ```bash
    0mcp axl setup /path/to/axl-binary
    ```

3.  **Initialize Mesh Identity:**
    ```bash
    0mcp axl init
    ```
    This generates your peer key and updates your `.env.0mcp`.

4.  **Discover and Trade:**
    ```bash
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
  wallet projects [--json]         List all known projects in storage
  keygen [--save]                  Generate Ethereum keypair (safe offline)

MEMORY
  memory list <project> [--json]   List all saved memory entries
  memory export <project>          Export full snapshot JSON to stdout or file

BRAIN
  brain mint <project>             Mint Brain iNFT + register ENS in one step
  brain load <ens-name> --into     Load external Brain into local project
  brain merge <e1> <e2> --output   Merge two brains into a new Super-Brain
  brain share <project> [--json]   Show ENS name + token ID
  brain status <project> [--json]  Show token, contract, entry count

AXL MESH (P2P)
  axl setup <path>                 Save the path to the AXL binary
  axl init                         Generate peer key and update .env
  axl list                         Show discovered peers on the mesh
  mesh discover [--keyword <tag>]  Find online brains by expertise
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
  --json     Output raw JSON (all read commands)
  --save     Persist generated keys to .env.0mcp
  --file     Write output to file instead of stdout
  --help     Show this help screen
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
| `BRAIN_ENS_NAME` | Your agent's primary ENS name (e.g., `agent.0mcp.eth`). |

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
