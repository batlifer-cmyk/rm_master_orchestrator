import { timingSafeEqual } from 'node:crypto';
import { hashRmRecordIdentity, RM_RECORD_ADMIN_EMAIL_HASH } from './rm-record-auth.js';

const ALLOWED_GOOGLE_EMAIL_HASHES = new Set([
  '465721ce3c923eb43f03d858c922e46a5a272fafa529e2d5726a76223d8098bf',
  RM_RECORD_ADMIN_EMAIL_HASH,
]);

function safeHashEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function googleEmailHash(email) {
  return hashRmRecordIdentity(email);
}

export function isAllowedRmGoogleEmail(email) {
  const actual = googleEmailHash(email);
  for (const expected of ALLOWED_GOOGLE_EMAIL_HASHES) {
    if (safeHashEqual(actual, expected)) return true;
  }
  return false;
}

export function isAdminRmGoogleEmail(email) {
  return safeHashEqual(googleEmailHash(email), RM_RECORD_ADMIN_EMAIL_HASH);
}
