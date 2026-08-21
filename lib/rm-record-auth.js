import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// SHA-256 of a high-entropy internal access key. The plaintext key is never committed.
const ACCESS_KEY_HASH = '50cbc0636cdf80f9c7dc8e1e4f6359efa4792ea35b70a9c8bbec93e98b48af8c';
export const RM_RECORD_ADMIN_EMAIL_HASH = 'bec4971889572883999c096d02cb901f730864b91564518fc8753be7678b903f';
const SESSION_COOKIE = 'rm_record_session';
const COOKIE_SESSION_MARKER = 'cookie-session';
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30;

export function verifyRmRecordAccessKey(input) {
  if (typeof input !== 'string' || input.length < 20) return false;
  const actual = createHash('sha256').update(input).digest();
  const expected = Buffer.from(ACCESS_KEY_HASH, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashRmRecordIdentity(value) {
  return createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
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

function sessionSecret() {
  return process.env.RM_RECORD_SESSION_SECRET || process.env.OPENAI_API_KEY || '';
}

function signSessionPayload(payload) {
  const secret = sessionSecret();
  if (!secret) throw new Error('RM Record session secret is not configured.');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(subject, maxAge = DEFAULT_MAX_AGE) {
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    sub: String(subject || 'internal'),
    exp: Math.floor(Date.now() / 1000) + maxAge,
  })).toString('base64url');
  return `${payload}.${signSessionPayload(payload)}`;
}

function verifySignedSession(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const [payload, signature] = value.split('.', 2);
  if (!payload || !signature) return null;
  let expected;
  try {
    expected = signSessionPayload(payload);
  } catch {
    return null;
  }
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data?.v !== 2 || typeof data?.sub !== 'string' || Number(data?.exp) <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionFromRequest(req) {
  const value = cookieValue(req, SESSION_COOKIE);
  const signed = verifySignedSession(value);
  if (signed) return signed;
  // Temporary migration support for cookies issued by the earlier V1 implementation.
  if (verifyRmRecordAccessKey(value)) return { v: 1, sub: 'internal-legacy', exp: 0 };
  return null;
}

function serializeSessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/api/rm-record; HttpOnly; Secure; SameSite=Strict`;
}

export function rmRecordSessionCookie(accessKey, maxAge = DEFAULT_MAX_AGE) {
  if (!verifyRmRecordAccessKey(accessKey)) throw new Error('Invalid RM Record access key.');
  return serializeSessionCookie(createSessionToken('internal', maxAge), maxAge);
}

export function rmRecordGoogleSessionCookie(emailHash, maxAge = DEFAULT_MAX_AGE) {
  if (!/^[a-f0-9]{64}$/.test(String(emailHash || ''))) throw new Error('Invalid Google identity hash.');
  return serializeSessionCookie(createSessionToken(`google:${emailHash}`, maxAge), maxAge);
}

export function clearRmRecordSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/api/rm-record; HttpOnly; Secure; SameSite=Strict`;
}

export function rmRecordSessionSubject(req) {
  return sessionFromRequest(req)?.sub || '';
}

export function isRmRecordAuthorized(req) {
  const sessionOk = Boolean(sessionFromRequest(req));
  const value = req.headers['x-rm-access-key'];
  const input = Array.isArray(value) ? value[0] : value;

  if (input === COOKIE_SESSION_MARKER) return sessionOk;
  if (typeof input === 'string' && input.length > 0) return verifyRmRecordAccessKey(input);
  return sessionOk;
}

export function isRmRecordAdmin(req) {
  const value = req.headers['x-rm-access-key'];
  const input = Array.isArray(value) ? value[0] : value;
  if (typeof input === 'string' && input !== COOKIE_SESSION_MARKER && input.length > 0) {
    return verifyRmRecordAccessKey(input);
  }
  const subject = rmRecordSessionSubject(req);
  return subject === 'internal' || subject === 'internal-legacy' || subject === `google:${RM_RECORD_ADMIN_EMAIL_HASH}`;
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

export function requireRmRecordAdmin(req, res) {
  if (isRmRecordAdmin(req)) return true;
  res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  return false;
}
