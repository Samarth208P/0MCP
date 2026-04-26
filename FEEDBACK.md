# Uniswap Developer Platform: Technical Feedback and Builder Experience

This report provides a comprehensive review of the Uniswap v4 SDK and Developer Platform, documented during the implementation of the 0MCP persistent memory layer.

---

### 1. What Worked: The High Points

*   **V4Planner Flexibility:** The introducion of the `V4Planner` architecture is a significant improvement over the v3 routing model. For agentic workflows like 0MCP, the ability to chain `SWAP_EXACT_IN_SINGLE` and `TAKE_ALL` allowed us to build an atomic "Settlement-as-a-Service" for brain rentals that is far more efficient than multi-step transactions.
*   **Singleton Architecture:** The v4 singleton pattern drastically simplified our gas estimation logic once the pool mapping was understood. It removes the "token approval loop" friction that often plagues automated agents.
*   **Sepolia Infrastructure:** The availability of robust testnet infrastructure for v4 meant we experienced zero downtime with the Universal Router during our integration phase.

---

### 2. DX Friction and The Big Bottlenecks

#### A. The JSBI vs native BigInt Dissonance
The most significant friction point in the current ecosystem is the lingering dependency on `JSBI` in `@uniswap/sdk-core`.
*   **The Problem:** Modern AI frameworks and high-performance SDKs (like the 0G Foundation SDK) are built on native `BigInt`. Mixing `v4-sdk` (which begins to support BigInt) with `sdk-core` (which mandates JSBI) leads to constant, silent type-conversion failures.
*   **The Cost:** We spent several hours debugging "PriceLimitExceeded" errors that were actually caused by precision loss during JSBI-to-BigInt casting.
*   **The Industry Context:** As the ecosystem moves toward headless, non-browser agents, the requirement for a legacy polyfill library like JSBI is becoming a major DX liability.

#### B. Documentation Gaps for Headless Environments
The documentation site is overwhelmingly tailored for React/Frontend developers.
*   **The Gap:** There is a critical lack of documentation for using the Uniswap API or SDK in a pure `stdio` or background worker context (such as an MCP server). 
*   **The Friction:** Most examples rely on `useWeb3React` or browser-injected providers. We had to reverse-engineer the Universal Router's calldata execution because the "Auto-Router" CLI examples were incomplete for Node.js environments.

---

### 3. Bugs and Technical Hurdles

*   **Universal Router Calldata Opaque Errors:** When constructing swaps for non-standard pools (v4 hooks), the SDK often generates calldata that fails with generic `ST_INVALID_INPUT` reverts. The lack of granular on-chain revert strings in the Universal Router contract makes debugging these "black box" failures extremely time-consuming.
*   **Price Limit Math Helpers:** The SDK lacks a simple `getSqrtPriceLimit` helper optimized for v4's tick-to-sqrtPrice math. Builders are currently forced to implement their own math utilities (as we did in our `keeper.ts`) to avoid transaction reverts during high-volatility periods on testnet.

---

### 4. The Wishlist: What We Wish Existed

1.  **Native BigInt Support:** A version of `sdk-core` that deprecates JSBI entirely. This is essential for the burgeoning AI agent sector.
2.  **Headless-First SDK:** An SDK distribution that does not assume the presence of a `window` or `provider` object, designed specifically for server-side execution and autonomous agents.
3.  **V4 Hook Callbacks:** A standardized "On-Success" hook that can trigger an external API or off-chain state change. This would allow 0MCP to "unlock" an ENS subname automatically the moment the Uniswap swap settles.
4.  **Granular Revert Strings:** Improved error messaging on the Universal Router contract to help developers distinguish between insufficient liquidity, slippage violations, and input formatting errors.

---

**Submission by:** 0MCP (Samarth Patel)
**Link:** [Project Repository](https://github.com/Samarth208P/0MCP)
