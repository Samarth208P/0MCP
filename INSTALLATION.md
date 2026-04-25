# 0MCP — Installation Guide

Welcome to the 0MCP ecosystem. 0MCP gives any AI coding agent (Cursor, VS Code, Windsurf) **persistent memory** on the 0G decentralised network and an **ENS identity** on Ethereum — turning sessions into compounding expertise.

---

## Step 1: Install & Initialise (2 minutes)

Open your project directory in a terminal and run:

```bash
npm install -g @samarth208p/0mcp@latest
0mcp init
```

The wizard will:
- Generate (or import) an Ethereum keypair
- Scaffold a `.env` file with all required settings pre-filled
- Ask for your desired **Brain name** (e.g. `sampy` → `sampy.0mcp.eth`)

> **Your brain name is automatically registered to your wallet** the first time you connect your IDE — no extra steps.

---

## Step 2: Get Testnet Tokens

Your wallet needs tokens on two networks:

| Token | Purpose | Faucet |
|---|---|---|
| **0G (Galileo)** | Memory storage writes | https://faucet.0g.ai |
| **Sepolia ETH** | ENS registration gas (or use the built-in paymaster) | https://sepoliafaucet.com |

> The built-in **ZeroG Paymaster** (`PAYMASTER_ADDRESS` in `.env`) can sponsor ENS gas if you have 0G tokens — so Sepolia ETH is optional.

---

## Step 3: Connect your IDE

Choose your IDE and add the 0MCP server exactly as shown.

### 🟢 Cursor

1. **Cursor Settings** → **Features** → **MCP**
2. Click **+ Add new MCP server**
3. Set **Type** to `stdio`, **Name** to `0mcp`
4. Set the **Command** to:
   ```
   npx.cmd -y @samarth208p/0mcp@latest start
   ```
   > On **Mac/Linux** use `npx`. On **Windows** you **must** use `npx.cmd`.
5. Click **Save** — the indicator should turn green immediately.

---

### 🔵 VS Code (Cline or Roo Code)

1. Open the Cline/Roo Code chat window
2. Click the **🔌 MCP Server** icon → **Configure MCP Servers**
3. Add the block inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "0mcp": {
      "command": "npx.cmd",
      "args": ["-y", "@samarth208p/0mcp@latest", "start"],
      "disabled": false,
      "alwaysAllow": ["save_memory", "get_context", "send_funds"]
    }
  }
}
```

4. Save the file — the server restarts automatically.

---

### 🟡 VS Code (Continue.dev)

1. Open Continue → click **⚙️** → `config.json`
2. Add to the `mcpServers` array:

```json
{
  "name": "0mcp",
  "command": "npx.cmd",
  "args": ["-y", "@samarth208p/0mcp@latest", "start"]
}
```

3. Restart VS Code entirely to load the tools.

---

### 🌊 Windsurf

1. Open **Windsurf Settings** → **MCP**
2. Click **Add Server**
3. Set **Transport** to `stdio`
4. Set **Command** to `npx.cmd -y @samarth208p/0mcp@latest start`
5. Save and reload.

---

## Step 4: Configure the AI System Prompt

Create a file called **`.cursorrules`** (Cursor) or **`.vscode/instructions.md`** (VS Code/Cline) in your project root with this content:

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
```

---

## Step 5: Verify It Works

Open your AI chat and test these prompts:

1. **Memory save:** *"Set a rule that our primary colour is #FF0000. Save it to memory."*
2. **Memory recall:** *"What colour rules do we have?"* (should retrieve the saved rule)
3. **Brain check:** *"What is my brain ENS name?"* (should see `yourname.0mcp.eth`)

---

## CLI Reference

```bash
0mcp init           # Setup wizard (run once)
0mcp health         # Check 0G + ENS connectivity
0mcp wallet status  # Balances, brain identity, paymaster status
0mcp memory list <project>   # List saved memory entries
0mcp brain mint <project>    # Mint Brain iNFT to the blockchain
0mcp ens resolve <name>      # Resolve brain ENS metadata
0mcp --help                  # Full command reference
```

---

## Troubleshooting

### MCP server not appearing in IDE
- Make sure you ran `0mcp init` first in the project directory
- Confirm the command uses `npx.cmd` on Windows (not `npx`)
- Try `0mcp health` to verify connectivity

### ENS registration fails
- Check `0mcp wallet status` — ensure you have Sepolia ETH **or** the paymaster is configured
- Run `0mcp ens register <project> <label>` manually to retry

### Brain name already taken
- The server detects this automatically and loads it as an **imported** brain
- To register your own, change `BRAIN_ENS_LABEL` in `.env` to a different name, then delete `BRAIN_ENS_REGISTERED=`

### Memory not persisting
- Run `0mcp health` to check 0G indexer connectivity
- Confirm `ZG_PRIVATE_KEY` and `MEMORY_REGISTRY_ADDRESS` are set in `.env`
- Check that your wallet has 0G tokens (needed for storage writes): https://faucet.0g.ai
