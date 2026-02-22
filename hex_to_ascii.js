// hex_to_ascii.js
const hex = (process.argv[2] || '').replace(/^0x/, '');
console.log(Buffer.from(hex, 'hex').toString('ascii'));
