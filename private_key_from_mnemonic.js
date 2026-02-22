import { TronWeb } from "tronweb";

const mnemonic = "all all all all all all all all all all all all"; // 12/24 words
const path = "m/44'/195'/0'/0/0";    // typical TRON derivation

const acct = await TronWeb.fromMnemonic(mnemonic, path);
// acct.privateKey, acct.publicKey, acct.address (base58), etc.
console.log(acct.address, acct.privateKey);
