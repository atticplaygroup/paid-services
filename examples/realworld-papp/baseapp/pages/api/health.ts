import type { NextApiRequest, NextApiResponse } from 'next';
export default function health(_req: NextApiRequest, res: NextApiResponse) { res.json({ ok: true }); }
