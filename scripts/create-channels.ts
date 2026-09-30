#!/usr/bin/env tsx
/**
 * scripts/create-channels.ts
 *
 * Admin utility to generate and fund channel accounts on Stellar testnet.
 * Usage:
 *   tsx scripts/create-channels.ts [--count=N] [--network=testnet]
 *
 * Outputs the generated secret keys to stdout — redirect to a secure secrets
 * manager; never commit the output.
 *
 * Example:
 *   tsx scripts/create-channels.ts --count=8 >> .env.local
 */
import { Keypair } from "@stellar/stellar-sdk";
import * as https from "https";

function parseCLIArgs(): { count: number; network: "testnet" | "mainnet" } {
  const count = parseInt(
    process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "8",
    10,
  );
  const network = (process.argv.find((a) => a.startsWith("--network="))?.split("=")[1] ??
    "testnet") as "testnet" | "mainnet";
  return { count, network };
}

async function friendbot(publicKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = `https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`;
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Friendbot returned HTTP ${res.statusCode}`));
        }
        res.resume();
      })
      .on("error", reject);
  });
}

async function main(): Promise<void> {
  const { count, network } = parseCLIArgs();

  if (network !== "testnet") {
    console.error(
      "ERROR: This script only supports testnet. Fund mainnet channels manually via a funded fee-source account.",
    );
    process.exit(1);
  }

  console.log(`Generating ${count} channel accounts for ${network}...\n`);

  const secrets: string[] = [];

  for (let i = 0; i < count; i++) {
    const kp = Keypair.random();
    const secret = kp.secret();
    const publicKey = kp.publicKey();
    secrets.push(secret);

    process.stdout.write(`[${i + 1}/${count}] ${publicKey} — funding via Friendbot... `);
    try {
      await friendbot(publicKey);
      console.log("✓");
    } catch (err) {
      console.log(`✗ (${(err as Error).message})`);
    }
  }

  console.log("\n--- CHANNEL_SECRET_KEYS (set in .env, never commit) ---");
  console.log(secrets.join(","));
  console.log("------------------------------------------------------");
  console.log(`\nSet this in your .env:\nCHANNEL_SECRET_KEYS=${secrets.join(",")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
