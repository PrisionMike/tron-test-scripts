#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { TronWeb } from 'tronweb';

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

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
    ) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function firstProvided(args, keys) {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function normalizeAction(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v !== 'transfer' && v !== 'approve') die('--action is required and must be transfer or approve');
  return v;
}

function parseUint256Arg(raw, flagName) {
  if (raw === undefined || raw === true) die(`--${flagName} is required`);
  if (!/^\d+$/.test(String(raw))) die(`--${flagName} must be a non-negative integer string (base units)`);
  return String(raw);
}

function parseFeeLimitSun(args) {
  const raw = args['fee-limit'];
  if (raw === undefined || raw === true) return 100_000_000;
  if (!/^\d+$/.test(String(raw))) die('--fee-limit must be a non-negative integer in SUN');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) die('--fee-limit is out of range');
  return n;
}

function parseMemo(args) {
  return typeof args.memo === 'string' ? args.memo : '';
}

function resolveOwnerAddress(args, tronWeb, derivedOwnerAddress) {
  const ownerAddress = firstProvided(args, ['owneraddress', 'ownerAddress', 'owner', 'from']);
  if (!ownerAddress) {
    if (derivedOwnerAddress) return derivedOwnerAddress;
    die('--owneraddress is required when TRON_PRIVATE_KEY is not available');
  }
  if (!tronWeb.isAddress(ownerAddress)) die('--owneraddress is not a valid TRON base58 address');
  if (derivedOwnerAddress && ownerAddress !== derivedOwnerAddress) {
    die(`--owneraddress (${ownerAddress}) does not match address derived from TRON_PRIVATE_KEY (${derivedOwnerAddress})`);
  }
  return ownerAddress;
}

function requireTronAddress(tronWeb, value, flag) {
  if (!value) die(`--${flag} is required`);
  if (!tronWeb.isAddress(value)) die(`--${flag} is not a valid TRON base58 address`);
  return value;
}

function parseApproveAmount(args) {
  if (args.max && args.amount !== undefined) die('Use either --amount or --max, not both');
  if (args.max) return { amount: MAX_UINT256, isMax: true };
  return { amount: parseUint256Arg(args.amount, 'amount'), isMax: false };
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);

  const action = normalizeAction(args.action);
  const tokenAddress = firstProvided(args, ['token', 'token-address', 'token-contract', 'contract']);
  const shouldSign = Boolean(args.sign);
  const shouldBroadcast = Boolean(args.broadcast);
  if (shouldBroadcast && !shouldSign) die('--broadcast requires --sign');

  const outFile = args.out || './output_jsons/tx_trc20.json';
  const feeLimit = parseFeeLimitSun(args);
  const memo = parseMemo(args);

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
  requireTronAddress(tronWeb, tokenAddress, 'token');

  let functionSelector;
  let parameters;
  let targetLabel;
  let amountLabel;

  if (action === 'transfer') {
    const to = firstProvided(args, ['to', 'toaddress', 'recipient']);
    const amount = parseUint256Arg(args.amount, 'amount');
    requireTronAddress(tronWeb, to, 'to');
    functionSelector = 'transfer(address,uint256)';
    parameters = [
      { type: 'address', value: to },
      { type: 'uint256', value: amount },
    ];
    targetLabel = `To:         ${to}`;
    amountLabel = `Amount:     ${amount}`;
  } else {
    const spender = firstProvided(args, ['spender', 'to', 'contract-address']);
    const { amount, isMax } = parseApproveAmount(args);
    requireTronAddress(tronWeb, spender, 'spender');
    functionSelector = 'approve(address,uint256)';
    parameters = [
      { type: 'address', value: spender },
      { type: 'uint256', value: amount },
    ];
    targetLabel = `Spender:    ${spender}`;
    amountLabel = `Amount:     ${isMax ? `${amount} (MAX)` : amount}`;
  }

  console.log(`Action:     ${action}`);
  console.log(`Owner:      ${ownerAddress}`);
  console.log(`Token:      ${tokenAddress}`);
  console.log(targetLabel);
  console.log(amountLabel);
  console.log(`Memo:       ${memo}`);
  console.log(`Fee Limit:  ${feeLimit} SUN`);
  console.log(`Sign:       ${shouldSign ? 'YES' : 'NO'}`);
  console.log(`Broadcast:  ${shouldBroadcast ? 'YES' : 'NO'}`);
  console.log(`Node:       ${fullNode}`);
  console.log(`Output:     ${outFile}`);

  const txExt = await tronWeb.transactionBuilder.triggerSmartContract(
    tokenAddress,
    functionSelector,
    { feeLimit },
    parameters,
    ownerAddress
  );

  if (!txExt?.transaction) {
    die(`No transaction returned. Response: ${JSON.stringify(txExt, null, 2)}`);
  }

  let txToWrite = await tronWeb.transactionBuilder.extendExpiration(
    txExt.transaction,
    20 * 60
  );

  if (memo) {
    txToWrite = await tronWeb.transactionBuilder.addUpdateData(txToWrite, memo, 'utf8');
  }

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
  if (shouldBroadcast) console.log('Wrote SIGNED TRC-20 transaction JSON and broadcasted.');
  else console.log(shouldSign ? 'Wrote SIGNED TRC-20 transaction JSON.' : 'Wrote UNSIGNED TRC-20 transaction JSON.');
}

main().catch((e) => die(e?.stack ?? String(e)));
