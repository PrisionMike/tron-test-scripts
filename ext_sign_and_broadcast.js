// sign_with_external_signature.js
//
// Usage:
//    node sign_with_external_signature.js <hex_signature>
//
// After signing, you will be prompted:
//    "Broadcast transaction? (y/N):"
//
// Requires TronWeb installed.

import fs from 'fs';
import readline from 'readline';
import { TronWeb } from 'tronweb';

const tronWeb = new TronWeb({
    fullHost: 'https://api.shasta.trongrid.io',
    privateKey: ''   // not required for broadcasting raw tx
});

async function askUser(q) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve =>
        rl.question(q, answer => {
            rl.close();
            resolve(answer.trim());
        })
    );
}

async function main() {
    const sig = process.argv[2];

    if (!sig) {
        console.error("Error: Provide a signature hex string as argument.");
        process.exit(1);
    }

    const normalizedSig = sig.startsWith("0x") ? sig.slice(2) : sig;

    const tx = JSON.parse(fs.readFileSync('tx_stake_bandwidth_10_all_unsigned.json', 'utf8'));

    // Attach signature array
    tx.signature = [normalizedSig];

    // Save signed transaction
    fs.writeFileSync('ex_signed_stake_bandwidth_10_all_tx.json', JSON.stringify(tx, null, 2));
    console.log("\nSigned transaction saved to ex_signed_stake_bandwidth_10_all_tx.json");

    // Ask user if they want to broadcast
    const ans = await askUser("\nBroadcast transaction? (y/N): ");

    if (ans.toLowerCase() !== 'y') {
        console.log("Not broadcasting. Exiting.");
        return;
    }

    console.log("\nBroadcasting...");

    try {
        const result = await tronWeb.trx.sendRawTransaction(tx);

        console.log("\nBroadcast result:", result);

        if (result.result === true && result.txid) {
            console.log(`TXID: ${result.txid}`);
            console.log(`Track at: https://shasta.tronscan.org/#/transaction/${result.txid}`);
        } else {
            console.log("Broadcast failed.", result.result);
        }

    } catch (err) {
        console.error("Broadcast failed:", err);
    }
}

main();
