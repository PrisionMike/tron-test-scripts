// broadcast.js
import { TronWeb } from 'tronweb';
import fs from 'fs';

const tronWeb = new TronWeb({
    fullHost: 'https://api.shasta.trongrid.io',
    privateKey: '' // not required for broadcasting
});

async function broadcastSigned() {
    try {
        const inputFile = process.argv[2];
        if (!inputFile) {
            console.error('Usage: node broadcast_tx.js <signed_tx_file.json>');
            process.exit(1);
        }

        const signedTx = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

        if (!signedTx.signature || signedTx.signature.length === 0) {
            throw new Error(`${inputFile} is missing a signature - cannot broadcast.`);
        }

        console.log("\nBroadcasting transaction...\n");

        const result = await tronWeb.trx.sendRawTransaction(signedTx);

        console.log("Broadcast result:", result);

        if (result.txid) {
            console.log(`\nTXID: ${result.txid}`);
            console.log(`Track it: https://shasta.tronscan.org/#/transaction/${result.txid}\n`);
        }

    } catch (err) {
        console.error("Broadcast failed:", err);
    }
}

broadcastSigned();
