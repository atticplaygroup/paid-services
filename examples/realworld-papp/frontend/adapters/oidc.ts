import { createRemoteJWKSet, jwtVerify } from 'jose';
const config = () => globalThis.PAID_CONFIG;
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
export async function login() {
  const verifier = random(), state = random(), nonce = random();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  sessionStorage.setItem('oidc', JSON.stringify({ verifier, state, nonce }));
  const target = new URL((config().oidcOrigin ?? config().issuer) + '/authorize');
  Object.entries({ client_id: 'realworld', response_type: 'code', scope: 'openid profile', redirect_uri: location.origin + '/callback', code_challenge: challenge, code_challenge_method: 'S256', state, nonce }).forEach(([k,v]) => target.searchParams.set(k,v));
  location.assign(target.href);
}
export async function callback() {
  const params = new URLSearchParams(location.search), pending = JSON.parse(sessionStorage.getItem('oidc') ?? 'null');
  sessionStorage.removeItem('oidc');
  if (!pending || pending.state !== params.get('state')) throw new Error('OIDC state mismatch');
  const origin = config().oidcOrigin ?? config().issuer;
  const response = await fetch(origin + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'realworld', redirect_uri: location.origin + '/callback', code: params.get('code') ?? '', code_verifier: pending.verifier }) });
  if (!response.ok) throw new Error('OIDC token exchange failed');
  const tokens = await response.json();
  const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(origin + '/jwks')), { issuer: config().issuer, audience: 'realworld' });
  if (payload.nonce !== pending.nonce) throw new Error('OIDC nonce mismatch');
  const session = await fetch(config().mutationOrigin + '/api/session', { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  if (!session.ok) throw new Error('Account session failed');
  localStorage.setItem('token', JSON.stringify(tokens.access_token));
  location.replace('/');
}
