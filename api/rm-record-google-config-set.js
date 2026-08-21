import { parseJsonBody, requireRmRecordAdmin } from '../lib/rm-record-auth.js';
import { saveRmGoogleClientId } from '../lib/rm-record-google-config.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!requireRmRecordAdmin(req, res)) return;
    return res.status(200).json({ admin: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!requireRmRecordAdmin(req, res)) return;

  try {
    const { clientId } = parseJsonBody(req);
    const saved = await saveRmGoogleClientId(clientId);
    return res.status(200).json({ ok: true, clientId: saved });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Google Client ID 저장에 실패했습니다.' });
  }
}
