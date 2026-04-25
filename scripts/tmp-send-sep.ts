import { ethers } from "ethers";
import fs from "node:fs";

async function main() {
  const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
  // Read .env directly to get the sender PK
  const content = fs.readFileSync(".env", "utf8");
  let pk = "";
  for (const line of content.split("\n")) {
    if (line.startsWith("ENS_PRIVATE_KEY=")) {
      pk = line.split("=")[1].trim();
      break;
    }
  }

  if (!pk) {
    throw new Error("Could not find ENS_PRIVATE_KEY in .env");
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  const recipient = "0x3dcf497E8130C1f15111E06C3A1c66384d282f3D";
  const amount = "0.2";

  console.log(`Sending ${amount} Sepolia ETH to ${recipient}...`);
  const tx = await wallet.sendTransaction({
    to: recipient,
    value: ethers.parseEther(amount)
  });
  console.log(`TX Hash: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  await tx.wait();
  console.log(`Transaction confirmed! Successfully sent ${amount} ETH on Sepolia.`);
}

main().catch(console.error);
