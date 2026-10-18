// Generate a signed provider manifest for the operator's exchange endpoint.
// node prepare-values.mjs [exchange-origin] [provider-seed-hex]
import { createHash, createECDH, createPrivateKey, sign } from 'node:crypto';
const host = process.argv[2] ?? 'http://quickstart-exchange-exchange:8080';
new URL(host);
const seed = process.argv[3] ? Buffer.from(process.argv[3].replace(/^0x/, ''), 'hex') : createHash('sha256').update('quickstart-demo-provider').digest();
if (seed.length !== 32) throw new Error('provider seed must contain 32 bytes');
const ec = createECDH('prime256v1');
ec.setPrivateKey(seed);
const pub = ec.getPublicKey();
const jwk = { crv: 'P-256', kty: 'EC', x: pub.subarray(1,33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
const thumbprint = createHash('sha256').update(JSON.stringify(jwk)).digest();
const bytes = Buffer.concat([Buffer.from([1,0xd1,0xd6,0x03,0x12,0x20]), thumbprint]);
let bits = 0, accumulator = 0, id = 'b';
for (const byte of bytes) { accumulator = (accumulator << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; id += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator >>> bits) & 31]; } }
if (bits) id += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator << (5-bits)) & 31];
const manifest = { version: 'v1', id, exchanges: [{ id: 'quickstart-exchange', hosts: [host], payment_coin: 'PAYMENT_COIN_SUI', payment_environment: 'PAYMENT_ENVIRONMENT_DEVNET' }] };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const input = `${encode({ alg: 'ES256', typ: 'PAID-provider-manifest', jwk })}.${encode(manifest)}`;
manifest.signature = `${input}.${sign('sha256', Buffer.from(input), { key: createPrivateKey({ key: { ...jwk, d: seed.toString('base64url') }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
console.log(JSON.stringify({ provider: { env: { validAudience: id, providerManifest: JSON.stringify(manifest) }, meter: { account: { validAudience: id } } } }, null, 2));
