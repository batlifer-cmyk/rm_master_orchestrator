import { createHash, timingSafeEqual } from 'node:crypto';

// SHA-256 of a high-entropy internal access key. The plaintext key is never committed.
const ACCESS_KEY_HASH = '50cbc0636cdf80f9c7dc8e1e4f6359efa4792ea35b70a9c8bbec93e98b48af8c';

export function verifyRmRecordAccessKey(input) {
  if (typeof input !== 'string' || input.length < 20) return false;
  const actual = createHash('sha256').update(input).digest();
  const expected = Buffer.from(ACCESS_KEY_HASH, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isRmRecordAuthorized(req) {
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
  res.status(401).json({ error: '접근키가 올바르지 않습니다.' });
  return false;
}
