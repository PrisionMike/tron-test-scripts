#!/usr/bin/env node

import bs58check from "bs58check";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node address_codec.js <tron_address_or_hex>");
  process.exit(1);
}

function isHex(addr) {
  return /^[0-9a-fA-F]+$/.test(addr) && addr.length === 42 && addr.startsWith("41");
}

function isBase58(addr) {
  return addr.startsWith("T");
}

try {
  if (isBase58(input)) {
    // Base58Check → hex
    const bytes = bs58check.decode(input);         // Uint8Array (often)
    const buf = Buffer.from(bytes);                // normalize
    console.log(buf.toString("hex"));
  } else if (isHex(input)) {
    // hex → Base58Check
    const buf = Buffer.from(input, "hex");
    console.log(bs58check.encode(buf));            // ok with Buffer
  } else {
    throw new Error("Unrecognized TRON address format (expected T... or 41... hex)");
  }
} catch (e) {
  console.error("Invalid address:", e.message);
  process.exit(1);
}
