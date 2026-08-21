import { getRmGoogleClientId } from '../lib/rm-record-google-config.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    const clientId = await getRmGoogleClientId();
    return res.status(200).json({ enabled: Boolean(clientId), clientId: clientId || null });
  } catch (error) {
    console.error('RM Record Google config failed:', error);
    return res.status(500).json({ enabled: false, clientId: null, error: 'Google 로그인 설정을 읽지 못했습니다.' });
  }
}
