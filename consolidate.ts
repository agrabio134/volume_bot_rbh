import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const monad = {
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
} as const;

const publicClient = createPublicClient({ 
  chain: monad, 
  transport: http(process.env.RPC_URL || 'https://rpc.monad.xyz') 
});

const TARGET_WALLET = '0xfe8c776314e296eb17b8b7aba33082add5b35b0d' as `0x${string}`;

async function main() {
  const filename = 'privekey.txt';
  const filePath = path.join(process.cwd(), filename);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ File ${filename} not found!`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);

  console.log(`📊 Loaded ${lines.length} wallets\n`);

  let success = 0, failed = 0, totalSent = 0n;

  for (const line of lines) {
    let pk: `0x${string}` | undefined;
    try {
      const pkMatch = line.match(/0x[a-fA-F0-9]{64}/);
      if (!pkMatch) continue;

      pk = pkMatch[0] as `0x${string}`;
      const account = privateKeyToAccount(pk);
      const walletClient = createWalletClient({ 
        chain: monad, 
        transport: http(process.env.RPC_URL!), 
        account 
      });

      const balance = await publicClient.getBalance({ address: account.address });

      if (balance < parseUnits("0.3", 18)) {
        console.log(`⏭️ ${account.address.slice(0,8)}... Too low (${formatUnits(balance, 18)} MON)`);
        continue;
      }

      const sendAmount = balance - parseUnits("0.25", 18);

      const txHash = await walletClient.sendTransaction({
        to: TARGET_WALLET,
        value: sendAmount,
        gas: 65000n,                    // Very safe for native transfer
        maxFeePerGas: parseUnits("0.00000012", 18),
        maxPriorityFeePerGas: parseUnits("0.000000002", 18)
      });

      console.log(`✅ SUCCESS → ${formatUnits(sendAmount, 18)} MON from ${account.address} | Tx: ${txHash}`);
      totalSent += sendAmount;
      success++;

      await new Promise(r => setTimeout(r, 1200)); // Reasonable delay

    } catch (e: any) {
      const failedKey = pk ? pk.slice(0,10) : 'unknown';
      console.log(`❌ Failed ${failedKey}... → ${e.shortMessage || e.message}`);
      failed++;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`🎉 CONSOLIDATION FINISHED!`);
  console.log(`✅ Successfully sent from ${success} wallets`);
  console.log(`💰 Total MON moved: ${formatUnits(totalSent, 18)}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📍 All funds sent to: ${TARGET_WALLET}`);
  console.log("=".repeat(70));
}

main().catch(console.error);