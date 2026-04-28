/**
 * TxLogger — singleton receipt collector for on-chain transactions.
 * Collects TX hashes during a session (CLI or MCP) and formats a summary
 * for the user/judge.
 */

export interface TxReceipt {
  chain: "0g" | "sepolia";
  label: string;
  txHash: string;
  gasUsed?: string;
  via: "paymaster" | "direct";
}

class TxLoggerSingleton {
  private receipts: TxReceipt[] = [];

  /**
   * Clears the current log (call at the start of a command/tool).
   */
  clear(): void {
    this.receipts = [];
  }

  /**
   * Records a new transaction receipt.
   */
  record(receipt: TxReceipt): void {
    this.receipts.push(receipt);
  }

  /**
   * Returns a formatted summary of all transactions recorded since the last clear().
   */
  summary(): string {
    if (this.receipts.length === 0) return "";

    const bar = "─".repeat(58);
    let out = "\n";
    out += `  ┌${bar}┐\n`;
    out += `  │  ${"TRANSACTION RECEIPTS".padEnd(56)}│\n`;
    out += `  └${bar}┘\n\n`;

    for (const r of this.receipts) {
      const symbol = r.chain === "0g" ? "● 0G" : "● SEPOLIA";
      const explorerBase = r.chain === "0g" 
        ? "https://chainscan-galileo.0g.ai/tx/"
        : "https://sepolia.etherscan.io/tx/";

      out += `    ${symbol} · ${r.label}\n`;
      out += `      via:   ${r.via}\n`;
      out += `      hash:  ${r.txHash}\n`;
      if (r.gasUsed) out += `      gas:   ${r.gasUsed}\n`;
      out += `      link:  ${explorerBase}${r.txHash}\n\n`;
    }

    return out;
  }

  getReceipts(): TxReceipt[] {
    return [...this.receipts];
  }
}

export const TxLogger = new TxLoggerSingleton();
