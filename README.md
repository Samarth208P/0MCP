<div align="center">
  <img src="https://raw.githubusercontent.com/Samarth208P/0MCP/main/0mcp.png" alt="0MCP Logo" width="200" />
  <h1>0MCP — Persistent Memory Layer for AI Coding Agents</h1>
  <p><em>0MCP anchors your AI agent's consciousness to the 0G decentralized network, turning ephemeral prompts into persistent, tradeable intelligence assets.</em></p>
  <p>Solo Project · Samarth Patel, IIT Roorkee</p>
</div>

---

## The 0G Advantage: Decentralized Agent Intelligence
0MCP is built primarily to leverage the **0G Foundation stack**. It transforms local AI coding agents into decentralized entities by treating the 0G Network as the permanent, secure, and verifiable repository of agent expertise.

- **0G Storage (KV/Log):** Every interaction is encrypted and logged to 0G, creating an immutable history of project decisions.
- **0G Chain (ERC-7857):** Agent expertise is assetized as "Brain iNFTs," allowing intelligence to be minted, shared, and monetized on the 0G network.
- **0G-Native Economy:** Users can operate entirely using 0G tokens, with gas and cross-chain complexities handled by our integrated Paymaster.

---

## Submission Details

*   **Project Name:** 0MCP
*   **Description:** A decentralized persistent memory layer for AI agents. 0MCP transforms stateless LLMs into long-term engineering partners by anchoring context to 0G Storage and identities to ENS.
*   **Demo Video:** [Link to 3-min Video] (Coming Soon)
*   **Live Demo:** [Link to Live Demo] (Coming Soon)
*   **Team:** Samarth Patel
    *   **Telegram:** [@samarth208p](https://t.me/samarth208p)
    *   **X (Twitter):** [SamPy4X](https://x.com/SamPy4X)

### Contract Deployment Addresses
| Contract | Address | Network |
|---|---|---|
| **Memory Registry** | `0xC5887CA90aC2A5c6f1E7FC536A5363B961F18813` | **0G Galileo (Testnet)** |
| **Brain iNFT (ERC-7857)** | `0xd07059e54017BbF424223cb089ffBC5e2558cF56` | **0G Galileo (Testnet)** |
| **ZeroG Paymaster** | `0xb1Ab695dbcbA334A60712234d46264A617AD6d7f` | **Sepolia (Ethereum)** |
| **Subname Registrar** | `0xA2C96740159b7a47541DEfF991aD5edfa671661d` | **Sepolia (Ethereum)** |

---

## Quick Start (Setup in 2 Minutes)

### 1. Install and Initialise
```bash
npm install -g @samarth208p/0mcp@latest
0mcp init
```
The wizard generates your keypair, scaffolds .env, and reserves your 0G Brain identity.

### 2. Get Testnet Tokens
- **0G tokens** -> https://faucet.0g.ai (The primary currency for memory storage)
- **Sepolia ETH** -> https://sepoliafaucet.com (Optional; the built-in 0G paymaster covers this)

---

## System Architecture: Powered by 0G

### 1. The Intelligence Vault (Context and Storage)
Memory is encrypted locally via AES-256-GCM and anchored to **0G Storage**. Retrieval uses a deterministic Keyword-Recency ranking to maximize relevance while minimizing token usage.

<div align="center">
  <img src="./maps/Context.png" alt="The Intelligence Vault Architecure" width="800" />
</div>

### 2. The Discovery Layer (ENS and Access)
ENS names (.0mcp.eth) act as the human-readable map to decentralized 0G brains. Rentals are issued as time-bound wrapped subnames.

<div align="center">
  <img src="./maps/Identity.png" alt="The Discovery Layer Architecture" width="800" />
</div>

---

## 0G Innovation: Brain iNFTs (ERC-7857)
0MCP introduces the concept of **Intelligent NFTs** on the 0G Chain. 
- **Assetization of Expertise:** Over weeks of development, your agent builds a unique "Mental Model" of your codebase. 0MCP allows you to mint this model as a tradeable iNFT.
- **Secure Portability:** Because the metadata points directly to 0G Storage roots, your agent's brain can be loaded into any IDE, anywhere in the world, while remaining cryptographically secured.

---

## THE CORE LOOP

1. **Prompt:** You type a prompt in your IDE.
2. **Retrieve:** 0MCP intercepts it, querying 0G for relevant project history.
3. **Decrypt and Inject:** Context is decrypted locally and injected into the LLM system prompt.
4. **Respond:** AI responds with full project memory.
5. **Encrypt and Save:** New insights are encrypted and logged back to 0G immutably.

*Built by Samarth Patel*
