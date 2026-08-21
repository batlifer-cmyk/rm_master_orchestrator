import { clearRmRecordSessionCookie } from '../lib/rm-record-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearRmRecordSessionCookie());
  return res.status(200).json({ ok: true });
}
