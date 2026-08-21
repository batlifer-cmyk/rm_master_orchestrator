import { createHash, timingSafeEqual } from 'node:crypto';

// SHA-256 of a high-entropy internal access key. The plaintext key is never committed.
const ACCESS_KEY_HASH = '50cbc0636cdf80f9c7dc8e1e4f6359efa4792ea35b70a9c8bbec93e98b48af8c';
const SESSION_COOKIE = 'rm_record_session';

export function verifyRmRecordAccessKey(input) {
  if (typeof input !== 'string' || input.length < 20) return false;
  const actual = createHash('sha256').update(input).digest();
  const expected = Buffer.from(ACCESS_KEY_HASH, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cookieValue(req, name) {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

export function rmRecordSessionCookie(accessKey, maxAge = 60 * 60 * 24 * 30) {
  return `${SESSION_COOKIE}=${encodeURIComponent(accessKey)}; Max-Age=${maxAge}; Path=/api/rm-record; HttpOnly; Secure; SameSite=Strict`;
}

export function clearRmRecordSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/api/rm-record; HttpOnly; Secure; SameSite=Strict`;
}

export function isRmRecordAuthorized(req) {
  const cookieKey = cookieValue(req, SESSION_COOKIE);
  if (verifyRmRecordAccessKey(cookieKey)) return true;

  // Legacy header support for existing clients during migration.
  const value = req.headers['x-rm-access-key'];
  const input = Array.isArray(value) ? value[0] : value;
  return verifyRmRecordAccessKey(input || '');
}

export function parseJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

export function requirePost(req, res) {
  if (req.method === 'POST') return true;
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Method Not Allowed' });
  return false;
}

export function requireRmRecordAuth(req, res) {
  if (isRmRecordAuthorized(req)) return true;
  res.status(401).json({ error: '로그인이 필요합니다.' });
  return false;
}
