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
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log([
    'Usage:',
    '  node build_approve_calls.js \\',
    '    --private-key <hex> \\',
    '    --token <TRC20_contract_address> \\',
    '    --spender <address_to_approve> \\',
    '    [--amount <base_units_integer> | --max] \\',
    '    [--fee-limit <sun>] [--out <file>] [--unsigned]',
    '',
    'Notes:',
    '  --amount must be base units (uint256 integer string).',
    '  --max sets amount to uint256 max (unlimited approval).',
    '  If --unsigned is omitted, the tx is signed with --private-key.',
  ].join('\n'));
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function requireStringArg(args, key) {
  const v = args[key];
  if (!v || typeof v !== 'string') die(`--${key} is required`);
  return v;
}

function firstProvided(args, keys) {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function normalizePrivateKey(raw) {
  const trimmed = String(raw).trim();
  const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    die('--private-key must be a 64-char hex string (optionally prefixed with 0x)');
  }
  return hex;
}

function parseFeeLimitSun(args) {
  const raw = args['fee-limit'];
  if (raw === undefined || raw === true) return 100_000_000;
  if (!/^\d+$/.test(String(raw))) die('--fee-limit must be a non-negative integer in SUN');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) die('--fee-limit is out of range');
  return n;
}

function parseApprovalAmount(args) {
  const useMax = Boolean(args.max);
  const raw = args.amount;

  if (useMax && raw !== undefined) {
    die('Use either --amount or --max, not both');
  }

  if (useMax) return { amount: MAX_UINT256, isMax: true };

  if (raw === undefined || raw === true) {
    die('--amount is required unless --max is used');
  }

  if (!/^\d+$/.test(String(raw))) {
    die('--amount must be a non-negative integer string (base units)');
  }

  return { amount: String(raw), isMax: false };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    usage();
    return;
  }

  const privateKey = normalizePrivateKey(requireStringArg(args, 'private-key'));
  const tokenAddress = firstProvided(args, ['token', 'token-address', 'token-contract']);
  const spenderAddress = firstProvided(args, ['spender', 'contract', 'contract-address', 'to']);
  if (!tokenAddress) die('--token is required (aliases: --token-address, --token-contract)');
  if (!spenderAddress) die('--spender is required (aliases: --contract, --contract-address, --to)');

  const { amount, isMax } = parseApprovalAmount(args);
  const feeLimit = parseFeeLimitSun(args);
  const outFile = args.out || 'approve_tx_signed.json';
  const shouldSign = !Boolean(args.unsigned);

  const fullNode = process.env.TRON_FULLNODE || 'https://api.shasta.trongrid.io';
  const solidityNode = process.env.TRON_SOLIDITYNODE || fullNode;
  const eventServer = process.env.TRON_EVENTSERVER || fullNode;

  const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

  tronWeb.setPrivateKey(privateKey);
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) die('Failed to derive owner address from --private-key');

  if (!tronWeb.isAddress(ownerAddress)) die('Derived owner address is invalid');
  if (!tronWeb.isAddress(tokenAddress)) die('--token is not a valid TRON address');
  if (!tronWeb.isAddress(spenderAddress)) die('--spender is not a valid TRON address');

  console.log(`Owner:      ${ownerAddress}`);
  console.log(`Token:      ${tokenAddress}`);
  console.log(`Spender:    ${spenderAddress}`);
  console.log(`Amount:     ${isMax ? `${amount} (MAX)` : amount}`);
  console.log(`Fee Limit:  ${feeLimit} SUN`);
  console.log(`Sign:       ${shouldSign ? 'YES' : 'NO (--unsigned)'}`);
  console.log(`Node:       ${fullNode}`);
  console.log(`Output:     ${outFile}`);

  const functionSelector = 'approve(address,uint256)';
  const parameters = [
    { type: 'address', value: spenderAddress },
    { type: 'uint256', value: amount },
  ];

  const txExt = await tronWeb.transactionBuilder.triggerSmartContract(
    tokenAddress,
    functionSelector,
    { feeLimit },
    parameters,
    ownerAddress
  );

  if (!txExt || !txExt.transaction) {
    die(`No transaction returned. Response: ${JSON.stringify(txExt, null, 2)}`);
  }

  let txToWrite = await tronWeb.transactionBuilder.extendExpiration(
    txExt.transaction,
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

  console.log('Done.');
  console.log(shouldSign ? 'Wrote SIGNED approval transaction JSON.' : 'Wrote UNSIGNED approval transaction JSON.');
}

main().catch((e) => die(e?.stack ?? String(e)));
