import { OAuth2Client } from 'google-auth-library';
import { parseJsonBody, rmRecordGoogleSessionCookie } from '../lib/rm-record-auth.js';
import { getRmGoogleClientId } from '../lib/rm-record-google-config.js';
import { googleEmailHash, isAllowedRmGoogleEmail, isAdminRmGoogleEmail } from '../lib/rm-record-google-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { credential } = parseJsonBody(req);
    if (typeof credential !== 'string' || credential.length < 100) {
      return res.status(400).json({ error: 'Google 로그인 토큰이 없습니다.' });
    }

    const clientId = await getRmGoogleClientId();
    if (!clientId) {
      return res.status(503).json({ error: 'Google 로그인이 아직 설정되지 않았습니다.' });
    }

    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    const email = String(payload?.email || '').trim().toLowerCase();

    if (!payload?.email_verified || !email) {
      return res.status(403).json({ error: '확인된 Google 이메일이 필요합니다.' });
    }
    if (!isAllowedRmGoogleEmail(email)) {
      return res.status(403).json({ error: 'RM Record 사용이 허용되지 않은 Google 계정입니다.' });
    }

    const emailHash = googleEmailHash(email);
    res.setHeader('Set-Cookie', rmRecordGoogleSessionCookie(emailHash));
    return res.status(200).json({
      ok: true,
      user: {
        name: String(payload?.name || ''),
        role: isAdminRmGoogleEmail(email) ? 'admin' : 'staff',
      },
      expiresInDays: 30,
    });
  } catch (error) {
    console.error('RM Record Google login failed:', error);
    return res.status(401).json({ error: 'Google 로그인 확인에 실패했습니다.' });
  }
}
