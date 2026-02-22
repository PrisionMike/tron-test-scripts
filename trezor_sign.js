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

function pickTronscanBase(fullNode) {
  const url = String(fullNode || '').toLowerCase();
  if (url.includes('shasta')) return 'https://shasta.tronscan.org/#/transaction/';
  if (url.includes('nile')) return 'https://nile.tronscan.org/#/transaction/';
  return 'https://tronscan.org/#/transaction/';
}

function logTxTiming(tx) {
  const ts = tx?.raw_data?.timestamp;
  const exp = tx?.raw_data?.expiration;
  if (typeof ts !== 'number' || typeof exp !== 'number') return;

  const now = Date.now();
  const remainingMs = exp - now;
  console.log(`TX timestamp: ${new Date(ts).toISOString()}`);
  console.log(`TX expires:   ${new Date(exp).toISOString()}`);
  if (remainingMs <= 0) console.log('Warning: transaction is already expired before broadcast attempt.');
  else console.log(`TX TTL left:  ${Math.floor(remainingMs / 1000)}s`);
}

function normalizeSignature(sig) {
  if (!sig || typeof sig !== 'string') die('--sign is required (hex signature)');
  const normalized = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (!/^[0-9a-fA-F]+$/.test(normalized)) die('--sign must be a hex string');
  if (normalized.length !== 130) die('--sign must be a 65-byte signature (130 hex chars)');
  return normalized;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);

  const inputFile = args.input || args.in;
  if (!inputFile || typeof inputFile !== 'string') die('--input is required');

  const outputFile = args.output || args.out;
  if (outputFile && typeof outputFile !== 'string') die('--output must be a file path');

  const signature = normalizeSignature(args.sign);
  const shouldBroadcast = Boolean(args.broadcast);

  const fullNode = process.env.TRON_FULLNODE || 'https://api.shasta.trongrid.io';
  const solidityNode = process.env.TRON_SOLIDITYNODE || fullNode;
  const eventServer = process.env.TRON_EVENTSERVER || fullNode;
  const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);
  const tronscanBase = pickTronscanBase(fullNode);

  let tx;
  try {
    tx = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    die(`Failed to read/parse input JSON: ${e?.message ?? String(e)}`);
  }

  if (!tx || typeof tx !== 'object') die('Input file does not contain a valid transaction JSON object');
  if (!tx.raw_data || !tx.raw_data_hex || !tx.txID) {
    die('Input JSON does not look like a Tron transaction (missing txID/raw_data/raw_data_hex)');
  }

  tx.signature = [signature];
  console.log(`Node: ${fullNode}`);

  if (outputFile) {
    ensureDirForFile(outputFile);
    fs.writeFileSync(outputFile, JSON.stringify(tx, null, 2), 'utf8');
    console.log(`Signed transaction saved to ${outputFile}`);
  } else {
    console.log('No --output provided, not saving signed transaction JSON.');
  }

  if (!shouldBroadcast) {
    console.log('Skipping broadcast (use --broadcast to send).');
    return;
  }

  logTxTiming(tx);

  try {
    const result = await tronWeb.trx.sendRawTransaction(tx);
    console.log('Broadcast result:', result);

    if (result?.txid) {
      console.log(`TXID: ${result.txid}`);
      console.log(`Track at: ${tronscanBase}${result.txid}`);
    }
  } catch (e) {
    die(`Broadcast failed: ${e?.message ?? String(e)}`);
  }
}

main().catch((e) => die(e?.stack ?? String(e)));
