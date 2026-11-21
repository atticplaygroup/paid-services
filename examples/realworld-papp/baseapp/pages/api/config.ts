import type { NextApiRequest, NextApiResponse } from 'next';
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ issuer: process.env.OIDC_ISSUER, oidcOrigin: process.env.OIDC_BROWSER_ORIGIN ?? 'https://localhost:4000', mutationOrigin: '' });
}
