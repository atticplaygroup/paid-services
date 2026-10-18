// OCI integration test keys must match the outproxies' direct-mode derivation.
const crypto = require('node:crypto');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const env = JSON.parse(input).spec.template.spec.containers[0].env;
  const mnemonic = env.find(item => item.name === 'DPOP_MASTER_SECRET').value.normalize('NFKD');
  const seed = crypto.createHash('sha256').update('direct').update(mnemonic).digest();
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(seed);
  const pub = ecdh.getPublicKey();
  process.stdout.write(JSON.stringify({ kty: 'EC', crv: 'P-256', d: seed.toString('base64url'),
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }));
});
