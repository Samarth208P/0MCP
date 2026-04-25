import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import "../src/env.js";

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
  const privKey = process.env.ENS_PRIVATE_KEY || process.env.ZG_PRIVATE_KEY;
  if (!privKey) throw new Error("No private key found in .env");

  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = new ethers.Wallet(privKey, provider);

  console.log(`Deploying from account: ${signer.address}`);

  const compiledPath = path.resolve(process.cwd(), "out/ZeroGPaymaster.sol/ZeroGPaymaster.json");
  if (!fs.existsSync(compiledPath)) {
    throw new Error(`Compiled contract not found at ${compiledPath}. Did you run 'forge build'?`);
  }

  const { abi, bytecode, deployedBytecode } = JSON.parse(fs.readFileSync(compiledPath, "utf-8"));
  
  // v0.7 EntryPoint
  const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
  
  const factory = new ethers.ContractFactory(abi, bytecode.object || bytecode, signer);
  console.log("Deploying ZeroGPaymaster...");
  
  // Deploy using the same address as signer for relay (for simplicity in this case)
  const relaySigner = signer.address;

  // Let's manually set gas params because Sepolia sometimes errors with ethers' estimate
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ? feeData.maxFeePerGas + ethers.parseUnits("5", "gwei") : undefined;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas + ethers.parseUnits("1", "gwei") : undefined;

  const contract = await factory.deploy(ENTRY_POINT, relaySigner, {
    maxFeePerGas,
    maxPriorityFeePerGas
  });

  await contract.waitForDeployment();
  const paymasterAddress = await contract.getAddress();
  console.log(`Paymaster deployed at: ${paymasterAddress}`);

  console.log("Funding paymaster with 4 ETH...");
  const tx = await (contract as any).deposit({
    value: ethers.parseEther("4"),
    maxFeePerGas,
    maxPriorityFeePerGas
  });
  console.log(`Funding tx: ${tx.hash}`);
  await tx.wait(1);
  console.log("Funding complete.");

  // Update .env
  const envPath = path.resolve(process.cwd(), ".env");
  let content = fs.readFileSync(envPath, "utf-8");
  
  const updateEnv = (key: string, value: string) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  };

  updateEnv("PAYMASTER_ADDRESS", paymasterAddress);
  updateEnv("RELAY_SIGNER_ADDRESS", relaySigner);
  fs.writeFileSync(envPath, content);
  console.log("Updated .env with PAYMASTER_ADDRESS and RELAY_SIGNER_ADDRESS.");
}

main().catch((err) => {
  console.log("Error details:");
  console.log(err.message);
  if (err.info || err.error) console.log(JSON.stringify(err.info || err.error, null, 2));
});
