import { isRmRecordAuthorized } from '../lib/rm-record-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!isRmRecordAuthorized(req)) {
    return res.status(401).json({ error: '접근키가 올바르지 않습니다.' });
  }

  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const blobConfigured = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
  return res.status(200).json({
    ok: openaiConfigured && blobConfigured,
    service: 'rm-record',
    version: '1.0.1',
    openaiConfigured,
    blobConfigured,
    blobAuth: process.env.BLOB_STORE_ID ? 'oidc' : process.env.BLOB_READ_WRITE_TOKEN ? 'token' : 'none',
  });
}
