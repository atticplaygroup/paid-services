import { createRemoteJWKSet, jwtVerify } from 'jose';
import prisma from '../lib/api/prisma';
const issuer = () => process.env.OIDC_ISSUER!;
let keys: ReturnType<typeof createRemoteJWKSet>;
export async function authenticate(authorization?: string) {
  if (!authorization?.startsWith('Bearer ')) throw new Error('Login required');
  keys ??= createRemoteJWKSet(new URL((process.env.OIDC_BACKCHANNEL_URL ?? issuer()) + '/jwks'));
  const { payload } = await jwtVerify(authorization.slice(7), keys, { issuer: issuer(), audience: process.env.OIDC_AUDIENCE ?? 'realworld' });
  if (!payload.sub) throw new Error('Missing subject');
  return payload;
}
export async function session(authorization?: string) {
  const payload = await authenticate(authorization);
  if (typeof payload.preferred_username !== 'string' || !payload.preferred_username.trim()) throw new Error('Username required');
  return prisma.user.upsert({ where: { id: payload.sub! }, create: { id: payload.sub!, username: payload.preferred_username }, update: {} });
}
