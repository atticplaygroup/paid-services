import type { NextApiRequest, NextApiResponse } from 'next';
import { session } from '../../adapters/session';
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();
  try { return res.json({ user: await session(req.headers.authorization) }); }
  catch (error: any) { console.error('OIDC session failed:', error.message); return res.status(401).json({ errors: ['Invalid session'] }); }
}
