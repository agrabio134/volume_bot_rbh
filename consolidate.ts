import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { robinhood, CONTROLLER_WALLET, getRpcUrl } from './chain';
dotenv.config();

const publicClient = createPublicClient({ 
  chain: robinhood,
  transport: http(getRpcUrl())
});

const TARGET_WALLET = CONTROLLER_WALLET;

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
        chain: robinhood,
        transport: http(getRpcUrl()),
        account 
      });

      const balance = await publicClient.getBalance({ address: account.address });

      if (balance < parseUnits("0.00003", 18)) {
        console.log(`⏭️ ${account.address.slice(0,8)}... Too low (${formatUnits(balance, 18)} ETH)`);
        continue;
      }

      const sendAmount = balance - parseUnits("0.00002", 18);

      const txHash = await walletClient.sendTransaction({
        to: TARGET_WALLET,
        value: sendAmount,
        gas: 65000n
      });

      console.log(`✅ SUCCESS → ${formatUnits(sendAmount, 18)} ETH from ${account.address} | Tx: ${txHash}`);
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
  console.log(`💰 Total ETH moved: ${formatUnits(totalSent, 18)}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📍 All funds sent to: ${TARGET_WALLET}`);
  console.log("=".repeat(70));
}

main().catch(console.error);
