#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parsePositiveInt(value, label) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) die(`${label} must be a positive integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) die(`${label} must be a safe integer > 0`);
  return n;
}

function parseOptionalPositiveInt(value, label) {
  if (value == null || value === false) return null;
  return parsePositiveInt(value, label);
}

function parseOptionalNonNegativeInt(value, label) {
  if (value == null || value === false) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) die(`${label} must be a non-negative integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) die(`${label} must be a safe integer >= 0`);
  return n;
}

function loadEnvFile(envPath = '.env') {
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) return;

  const content = fs.readFileSync(resolved, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] != null) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function inferBlockNumber(block) {
  const candidates = [
    block?.block_header?.raw_data?.number,
    block?.block_header?.raw_data?.num,
    block?.blockID?.number,
    block?.number,
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && Number.isSafeInteger(c)) return c;
    if (typeof c === 'string' && /^\d+$/.test(c)) return Number(c);
  }
  return null;
}

function getContractType(tx) {
  return tx?.raw_data?.contract?.[0]?.type ?? null;
}

function getVotesArray(tx) {
  const value = tx?.raw_data?.contract?.[0]?.parameter?.value;
  if (!value || typeof value !== 'object') return [];
  return Array.isArray(value.votes) ? value.votes : [];
}

function isVoteWitnessTx(tx) {
  const type = getContractType(tx);
  if (type === 'VoteWitnessContract') return true;

  const typeUrl = tx?.raw_data?.contract?.[0]?.parameter?.type_url;
  if (typeof typeUrl === 'string' && typeUrl.includes('VoteWitnessContract')) return true;

  return false;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(baseUrl, endpoint, body, headers = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${endpoint}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  if (json?.Error || json?.error) {
    throw new Error(`RPC error from ${endpoint}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return json;
}

async function getNowBlockNumber(baseUrl, headers) {
  const data = await postJson(baseUrl, '/wallet/getnowblock', {}, headers);
  const n = inferBlockNumber(data);
  if (n == null) throw new Error('Could not determine latest block number from /wallet/getnowblock');
  return n;
}

async function getBlocksBatch(baseUrl, startNum, endExclusive, headers) {
  const data = await postJson(
    baseUrl,
    '/wallet/getblockbylimitnext',
    { startNum, endNum: endExclusive },
    headers
  );

  if (Array.isArray(data?.block)) return data.block;
  if (Array.isArray(data?.blocks)) return data.blocks;
  return [];
}

async function getBlockByNum(baseUrl, num, headers) {
  return postJson(baseUrl, '/wallet/getblockbynum', { num }, headers);
}

function printDistribution(dist, totalVoteTxs, blocksScanned, startedFrom, endedAt) {
  console.log('\n=== Vote Candidate Count Distribution ===');
  console.log(`Vote txs analyzed: ${totalVoteTxs}`);
  console.log(`Blocks scanned:     ${blocksScanned}`);
  console.log(`Block range:        ${startedFrom} -> ${endedAt}`);
  console.log('');

  const rows = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  console.log('candidates_per_tx,count,percent');
  for (const [candidateCount, count] of rows) {
    const pct = totalVoteTxs > 0 ? ((count / totalVoteTxs) * 100).toFixed(4) : '0.0000';
    console.log(`${candidateCount},${count},${pct}`);
  }
}

function writeOutputFile(outFile, payload) {
  if (!outFile) return;
  const resolved = path.resolve(outFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\nWrote JSON summary: ${resolved}`);
}

async function main() {
  if (typeof fetch !== 'function') {
    die('This script requires Node.js 18+ (global fetch missing).');
  }

  const args = parseArgs(process.argv);
  const envFile = String(args.env || '.env');
  loadEnvFile(envFile);

  const fullNode = process.env.TRON_FULLNODE || 'https://api.trongrid.io';
  const tronApiKey = process.env.TRON_API_KEY || process.env.TRONGRID_API_KEY || null;

  const targetVotes = parsePositiveInt(args.target || args.count || '10000', '--target');
  const chunkSize = parsePositiveInt(args.chunk || '64', '--chunk');
  const progressEvery = parsePositiveInt(args.progressEvery || '100', '--progressEvery');
  const startBlockArg = parseOptionalNonNegativeInt(args.startBlock, '--startBlock');
  const maxBlocks = parseOptionalPositiveInt(args.maxBlocks, '--maxBlocks');
  const delayMs = parseOptionalNonNegativeInt(args.delayMs, '--delayMs') ?? 0;
  const outFile = args.out || null;

  if (chunkSize > 500) {
    die('--chunk > 500 is not recommended; lower it to reduce RPC payload size');
  }

  const headers = tronApiKey ? { 'TRON-PRO-API-KEY': tronApiKey } : {};

  const latestBlock = await getNowBlockNumber(fullNode, headers);
  let current = startBlockArg ?? latestBlock;
  const scanStart = current;

  console.log(`Fullnode:         ${fullNode}`);
  console.log(`Latest block:     ${latestBlock}`);
  console.log(`Start block:      ${current}`);
  console.log(`Target vote txs:  ${targetVotes}`);
  console.log(`Chunk size:       ${chunkSize} blocks/request`);
  if (maxBlocks != null) console.log(`Max blocks:       ${maxBlocks}`);
  if (tronApiKey) console.log('API key header:   YES (TRON-PRO-API-KEY)');
  console.log('Scanning backward for VoteWitnessContract txs...');

  const distribution = new Map();
  let voteTxCount = 0;
  let totalTxSeen = 0;
  let blocksScanned = 0;
  let lastBlockProcessed = current;
  let usedSingleBlockFallback = false;

  while (current >= 0 && voteTxCount < targetVotes) {
    if (maxBlocks != null && blocksScanned >= maxBlocks) break;

    const remainingBlocksAllowed = maxBlocks == null ? chunkSize : Math.min(chunkSize, maxBlocks - blocksScanned);
    if (remainingBlocksAllowed <= 0) break;

    const batchStart = Math.max(0, current - remainingBlocksAllowed + 1);
    const batchEndExclusive = current + 1;

    let blocks;
    try {
      blocks = await getBlocksBatch(fullNode, batchStart, batchEndExclusive, headers);
    } catch (e) {
      if (!usedSingleBlockFallback) {
        console.warn(`Batch block RPC failed (${e.message}). Falling back to per-block requests.`);
        usedSingleBlockFallback = true;
      }
      blocks = [];
      for (let n = batchStart; n < batchEndExclusive; n++) {
        try {
          const b = await getBlockByNum(fullNode, n, headers);
          blocks.push(b);
          if (delayMs > 0) await sleep(delayMs);
        } catch (inner) {
          console.warn(`Skipping block ${n}: ${inner.message}`);
        }
      }
    }

    if (!Array.isArray(blocks)) blocks = [];

    const byNumberDesc = blocks
      .map((b) => ({ block: b, num: inferBlockNumber(b) }))
      .filter((x) => x.num != null)
      .sort((a, b) => b.num - a.num);

    for (const { block, num } of byNumberDesc) {
      if (num > current) continue;
      lastBlockProcessed = num;
      blocksScanned++;

      const txs = Array.isArray(block?.transactions) ? block.transactions : [];
      totalTxSeen += txs.length;

      for (const tx of txs) {
        if (!isVoteWitnessTx(tx)) continue;

        const candidateCount = getVotesArray(tx).length;
        distribution.set(candidateCount, (distribution.get(candidateCount) || 0) + 1);
        voteTxCount++;

        if (voteTxCount >= targetVotes) break;
      }

      if (voteTxCount >= targetVotes) break;
      if (blocksScanned % progressEvery === 0) {
        console.log(
          `Progress: blocks=${blocksScanned}, txs_seen=${totalTxSeen}, vote_txs=${voteTxCount}, current_block=${num}`
        );
      }
    }

    if (voteTxCount >= targetVotes) break;

    current = batchStart - 1;
    if (delayMs > 0) await sleep(delayMs);
  }

  printDistribution(distribution, voteTxCount, blocksScanned, scanStart, lastBlockProcessed);

  writeOutputFile(outFile, {
    generatedAt: new Date().toISOString(),
    fullNode,
    latestBlock,
    startBlock: scanStart,
    endBlock: lastBlockProcessed,
    targetVoteTransactions: targetVotes,
    analyzedVoteTransactions: voteTxCount,
    blocksScanned,
    totalTransactionsSeen: totalTxSeen,
    chunkSize,
    maxBlocks: maxBlocks ?? null,
    delayMs,
    distribution: Object.fromEntries([...distribution.entries()].sort((a, b) => a[0] - b[0])),
  });

  if (voteTxCount < targetVotes) {
    console.warn(`\nStopped before reaching target (${voteTxCount}/${targetVotes}). Increase --maxBlocks or start earlier.`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  die(e?.stack || e?.message || String(e));
});
