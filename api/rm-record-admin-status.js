import { isRmRecordAdmin } from '../lib/rm-record-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!isRmRecordAdmin(req)) {
    return res.status(403).json({ admin: false });
  }
  return res.status(200).json({ admin: true });
}
