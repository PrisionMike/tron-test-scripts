#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { TronWeb } from 'tronweb';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;

    const key = a.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function loadDotEnv(dotEnvPath = '.env') {
  const absPath = path.resolve(dotEnvPath);
  if (!fs.existsSync(absPath)) return;

  const content = fs.readFileSync(absPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

function normalizeResource(reason) {
  if (!reason) die('--reason is required (ENERGY or BANDWIDTH)');
  const r = String(reason).trim().toUpperCase();
  if (r !== 'ENERGY' && r !== 'BANDWIDTH') die('--reason must be ENERGY or BANDWIDTH');
  return r;
}

function parseSunArg(args) {
  const v = args.sun;
  if (!v || typeof v !== 'string') die('--sun is required and must be a decimal string');
  if (!/^\d+$/.test(v)) die('--sun must be a non-negative integer');

  const sun = BigInt(v);
  if (sun <= 0n) die('--sun must be > 0');

  const MAX_I64 = 9223372036854775807n;
  if (sun > MAX_I64) die('--sun exceeds int64 max (2^63-1)');

  return sun.toString(10); // canonical decimal string
}

function resolveOwnerAddress(args, tronWeb, derivedOwnerAddress) {
  const ownerAddress = args.owneraddress || args.ownerAddress;
  if (!ownerAddress) {
    if (derivedOwnerAddress) return derivedOwnerAddress;
    die('--owneraddress is required when TRON_PRIVATE_KEY is not available');
  }
  if (typeof ownerAddress !== 'string') die('--owneraddress must be a TRON base58 address');
  if (!tronWeb.isAddress(ownerAddress)) die('--owneraddress is not a valid TRON base58 address');
  if (derivedOwnerAddress && ownerAddress !== derivedOwnerAddress) {
    die(`--owneraddress (${ownerAddress}) does not match address derived from TRON_PRIVATE_KEY (${derivedOwnerAddress})`);
  }
  return ownerAddress;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);

  const amountSun = parseSunArg(args);
  const resource = normalizeResource(args.reason);
  const outFile = args.out || './output_jsons/tx_unstake.json';
  const shouldSign = Boolean(args.sign);
  const shouldBroadcast = Boolean(args.broadcast);
  if (shouldBroadcast && !shouldSign) die('--broadcast requires --sign');

  const fullNode = process.env.TRON_FULLNODE || 'https://api.shasta.trongrid.io';
  const solidityNode = process.env.TRON_SOLIDITYNODE || fullNode;
  const eventServer = process.env.TRON_EVENTSERVER || fullNode;

  const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);
  const privateKey = process.env.TRON_PRIVATE_KEY || null;
  if (shouldSign && !privateKey) die('Set TRON_PRIVATE_KEY in .env or environment to use --sign');

  let derivedOwnerAddress = null;
  if (privateKey) {
    tronWeb.setPrivateKey(privateKey);
    derivedOwnerAddress = tronWeb.defaultAddress?.base58;
    if (!derivedOwnerAddress) die('Failed to derive owner address from TRON_PRIVATE_KEY');
  }

  const ownerAddress = resolveOwnerAddress(args, tronWeb, derivedOwnerAddress);

  console.log(`Owner:      ${ownerAddress}`);
  console.log(`Amount:     ${amountSun} SUN`);
  console.log(`Reason:     ${resource}`);
  console.log(`Sign:       ${shouldSign ? 'YES' : 'NO'}`);
  console.log(`Broadcast:  ${shouldBroadcast ? 'YES' : 'NO'}`);
  console.log(`Node:       ${fullNode}`);
  console.log(`Output:     ${outFile}`);

  let unsignedTx;
  console.log(`Building transaction... amountSun: ${amountSun}`);
  unsignedTx = await tronWeb.transactionBuilder.unfreezeBalanceV2(
    amountSun,
    resource,
    ownerAddress
  );

  let txToWrite = await tronWeb.transactionBuilder.extendExpiration(
    unsignedTx,
    20 * 60
  );

  if (shouldSign) {
    try {
      txToWrite = await tronWeb.trx.sign(txToWrite, privateKey);
    } catch (e) {
      die(`Failed to sign tx: ${e?.message ?? String(e)}`);
    }
  }

  ensureDirForFile(outFile);
  fs.writeFileSync(outFile, JSON.stringify(txToWrite, null, 2), 'utf8');

  if (shouldBroadcast) {
    try {
      const result = await tronWeb.trx.sendRawTransaction(txToWrite);
      console.log('Broadcast result:', result);
      if (result?.txid) console.log(`TXID: ${result.txid}`);
    } catch (e) {
      die(`Failed to broadcast tx: ${e?.message ?? String(e)}`);
    }
  }

  console.log('Done.');
  if (shouldBroadcast) console.log('Wrote SIGNED transaction JSON and broadcasted.');
  else console.log(shouldSign ? 'Wrote SIGNED transaction JSON.' : 'Wrote UNSIGNED transaction JSON.');
}

main().catch((e) => die(e?.stack ?? String(e)));
