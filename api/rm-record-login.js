import { parseJsonBody, rmRecordSessionCookie, verifyRmRecordAccessKey } from '../lib/rm-record-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { accessKey } = parseJsonBody(req);
  if (!verifyRmRecordAccessKey(accessKey || '')) {
    return res.status(401).json({ error: '접근키가 올바르지 않습니다.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', rmRecordSessionCookie(accessKey));
  return res.status(200).json({ ok: true, expiresInDays: 30 });
}
