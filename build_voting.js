#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { TronWeb } from 'tronweb';

const TEST_PRIVATE_KEY = '8d596057e510b14cbb9bf24f88803a6d6dbd138dd303a62b175b9e6cc0f3f941';

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

function parsePositiveInteger(value, label) {
  const normalized = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) {
    die(`${label} must be a positive integer`);
  }

  const n = Number(normalized);
  if (!Number.isSafeInteger(n) || n <= 0) {
    die(`${label} must be a safe integer > 0`);
  }

  return n;
}

function loadVotesMapFromFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    die(`Input file not found: ${resolved}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    die(`Failed to parse JSON file ${resolved}: ${e?.message ?? String(e)}`);
  }

  const rows = Array.isArray(parsed) ? parsed : parsed?.votes;
  if (!Array.isArray(rows) || rows.length === 0) {
    die('Input JSON must be an array or an object with a non-empty "votes" array');
  }

  const out = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      die(`votes[${i}] must be an object`);
    }

    const candidate = String(row.candidate ?? row.address ?? '').trim();
    if (!candidate) {
      die(`votes[${i}] must contain "candidate" (or "address")`);
    }

    if (candidate in out) {
      die(`Duplicate candidate address found: ${candidate}`);
    }

    const allocation = row.allocation ?? row.votes ?? row.voteCount;
    out[candidate] = parsePositiveInteger(allocation, `votes[${i}].allocation`);
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputFile = args.input || 'vote_allocations_sample.json';
  const outFile = args.out || 'vote_tx.json';
  const shouldBroadcast = Boolean(args.broadcast);

  const fullNode = process.env.TRON_FULLNODE || 'https://api.shasta.trongrid.io';
  const solidityNode = process.env.TRON_SOLIDITYNODE || fullNode;
  const eventServer = process.env.TRON_EVENTSERVER || fullNode;

  const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);
  const privateKey = TEST_PRIVATE_KEY;

  tronWeb.setPrivateKey(privateKey);
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) die('Failed to derive owner address from hardcoded private key');

  const votesMap = loadVotesMapFromFile(inputFile);
  const candidateCount = Object.keys(votesMap).length;
  const totalVotes = Object.values(votesMap).reduce((acc, n) => acc + n, 0);

  console.log(`Owner:      ${ownerAddress}`);
  console.log(`Contract:   VoteWitnessContract`);
  console.log(`Input:      ${inputFile}`);
  console.log(`Candidates: ${candidateCount}`);
  console.log(`TotalVotes: ${totalVotes}`);
  console.log(`Sign:       YES`);
  console.log(`Broadcast:  ${shouldBroadcast ? 'YES' : 'NO'}`);
  console.log(`Node:       ${fullNode}`);
  console.log(`Output:     ${outFile}`);

  let unsignedTx;
  console.log('Building transaction...');
  unsignedTx = await tronWeb.transactionBuilder.vote(votesMap, ownerAddress);

  let txToWrite = await tronWeb.transactionBuilder.extendExpiration(
    unsignedTx,
    20 * 60
  );

  try {
    txToWrite = await tronWeb.trx.sign(txToWrite, privateKey);
  } catch (e) {
    die(`Failed to sign tx: ${e?.message ?? String(e)}`);
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
  console.log(shouldBroadcast ? 'Wrote SIGNED transaction JSON and broadcasted.' : 'Wrote SIGNED transaction JSON.');
}

main().catch((e) => die(e?.stack ?? String(e)));
