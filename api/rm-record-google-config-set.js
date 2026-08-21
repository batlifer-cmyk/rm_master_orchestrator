import { parseJsonBody, requirePost, requireRmRecordAdmin } from '../lib/rm-record-auth.js';
import { saveRmGoogleClientId } from '../lib/rm-record-google-config.js';

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireRmRecordAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { clientId } = parseJsonBody(req);
    const saved = await saveRmGoogleClientId(clientId);
    return res.status(200).json({ ok: true, clientId: saved });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Google Client ID 저장에 실패했습니다.' });
  }
}
