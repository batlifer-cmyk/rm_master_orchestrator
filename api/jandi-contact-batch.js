import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export const config = { maxDuration: 30 };

const KEY_HASH_HEX = '5b78269cb7cdd0108201e3612294418407b177b2e91f44b43dc2684c0b12da26';
const UPSTREAM_IV_B64URL = 'DRFUXzJO8VrUoxT7';
const UPSTREAM_CIPHERTEXT_B64URL = 'uqpFTq91VTDm_lhGE65dm5Trb9OTVKkL8Lgzi4T4faN9Mg_bXPw0hlTaD_VLKZWSXj47OhuViR-4Yc_ITf3RnDQ2l8AKHjS0YjTeVauSq_EuMGRF3CY5gDGiQnFQtNnpMVR9ZqILzpranLbuyNsiKg';
const UPSTREAM_TAG_B64URL = 'C0NUyT7JZdN5cJVbe-_5YQ';
const MAX_CONTACTS = 20;
const PHONE_RE = /(?<!\d)(01[016789])[\s-]?(\d{3,4})[\s-]?(\d{4})(?!\d)/g;

function asString(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function decodeKey(raw) {
  try {
    const key = Buffer.from(asString(raw), 'base64url');
    return key.length === 32 ? key : null;
  } catch (_) {
    return null;
  }
}

function authorized(req) {
  const key = decodeKey(req.query?.k);
  if (!key) return null;
  const actual = createHash('sha256').update(key).digest();
  const expected = Buffer.from(KEY_HASH_HEX, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return key;
}

function decryptUpstream(key) {
  const iv = Buffer.from(UPSTREAM_IV_B64URL, 'base64url');
  const ciphertext = Buffer.from(UPSTREAM_CIPHERTEXT_B64URL, 'base64url');
  const tag = Buffer.from(UPSTREAM_TAG_B64URL, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function normalizePayloadBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

function stripCommand(text) {
  return String(text || '')
    .replace(/^\s*\/\s*연락처\b\s*/i, '')
    .replace(/^\s*\/연락처\b\s*/i, '')
    .trim();
}

function formatPhone(groups) {
  const [, prefix, middle, last] = groups;
  return `${prefix}-${middle}-${last}`;
}

function cleanName(prefix) {
  return String(prefix || '')
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '')
    .replace(/^\s*\/\s*연락처\s*/i, '')
    .replace(/^\s*\/연락처\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBatch(rawText) {
  const text = stripCommand(rawText);
  const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const contacts = [];
  const skipped = [];
  const seen = new Set();

  for (const originalLine of lines) {
    const line = stripCommand(originalLine);
    PHONE_RE.lastIndex = 0;
    const match = PHONE_RE.exec(line);
    if (!match) {
      skipped.push(originalLine);
      continue;
    }

    const name = cleanName(line.slice(0, match.index));
    if (!name) {
      skipped.push(originalLine);
      continue;
    }

    const phone = formatPhone(match);
    const key = `${name}\u0000${phone.replace(/\D/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push({ name, phone, sourceLine: originalLine });
  }

  return { contacts: contacts.slice(0, MAX_CONTACTS), skipped, truncated: contacts.length > MAX_CONTACTS };
}

function countPhoneCandidates(rawText) {
  const text = String(rawText || '');
  const matches = text.match(/(?<!\d)01[016789][\s-]?\d{3,4}[\s-]?\d{4}(?!\d)/g);
  return matches ? matches.length : 0;
}

async function callUpstream(upstream, payload) {
  const response = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {}
  return {
    ok: response.ok,
    status: response.status,
    body: parsed && typeof parsed.body === 'string' ? parsed.body : text.trim(),
    json: parsed,
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { ok: false, status: 0, body: error?.message || 'upstream_error', json: null };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function jandiResponse(body, color = '#BBCBCD') {
  return { body, connectColor: color };
}

export default async function handler(req, res) {
  const key = authorized(req);
  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'jandi-contact-batch', maxContacts: MAX_CONTACTS });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const payload = normalizePayloadBody(req);
  const keyword = String(payload.keyword || '').replace(/^\//, '').trim();
  const fullText = String(payload.text || '');
  const dataText = String(payload.data || '');
  const rawText = dataText || stripCommand(fullText);

  if (keyword && keyword !== '연락처') {
    return res.status(400).json(jandiResponse('이 주소는 /연락처 전용입니다.', '#E67E22'));
  }

  let upstream;
  try {
    upstream = decryptUpstream(key);
  } catch (error) {
    console.error('jandi-contact-batch upstream decrypt failed', error);
    return res.status(500).json(jandiResponse('연락처 연결 설정을 읽지 못했습니다.', '#E74C3C'));
  }

  const candidateCount = countPhoneCandidates(rawText || fullText);

  // 완전한 하위 호환: 전화번호가 0~1개면 현재 Apps Script에 원문 그대로 전달한다.
  if (candidateCount <= 1) {
    try {
      const upstreamResult = await callUpstream(upstream, payload);
      if (upstreamResult.json && typeof upstreamResult.json === 'object') {
        return res.status(upstreamResult.status || 200).json(upstreamResult.json);
      }
      return res.status(upstreamResult.status || 200).send(upstreamResult.body || '');
    } catch (error) {
      console.error('jandi-contact-batch single passthrough failed', error);
      return res.status(502).json(jandiResponse('기존 연락처 저장 서버 호출에 실패했습니다.', '#E74C3C'));
    }
  }

  const { contacts, skipped, truncated } = parseBatch(rawText || fullText);
  if (!contacts.length) {
    // 파싱할 수 없으면 기존 Apps Script가 원래의 안내문을 만들도록 그대로 넘긴다.
    try {
      const upstreamResult = await callUpstream(upstream, payload);
      if (upstreamResult.json && typeof upstreamResult.json === 'object') {
        return res.status(upstreamResult.status || 200).json(upstreamResult.json);
      }
      return res.status(upstreamResult.status || 200).send(upstreamResult.body || '');
    } catch (error) {
      return res.status(502).json(jandiResponse('연락처 저장 서버 호출에 실패했습니다.', '#E74C3C'));
    }
  }

  const results = await mapWithConcurrency(contacts, 3, async contact => {
    const oneLine = `${contact.name} ${contact.phone}`;
    const forwarded = {
      ...payload,
      keyword: payload.keyword || '연락처',
      text: `/연락처 ${oneLine}`,
      data: oneLine,
    };
    return callUpstream(upstream, forwarded);
  });

  const lines = [];
  let saved = 0;
  let failed = 0;

  results.forEach((result, index) => {
    const contact = contacts[index];
    const message = String(result?.body || '').replace(/\s+/g, ' ').trim();
    const looksSaved = result?.ok && /저장\s*완료|저장완료/.test(message);
    if (looksSaved) {
      saved += 1;
      lines.push(`✅ ${contact.name} ${contact.phone}`);
    } else {
      failed += 1;
      lines.push(`⚠️ ${contact.name} ${contact.phone}${message ? ` — ${message}` : ''}`);
    }
  });

  const skippedUseful = skipped.filter(line => !/^\s*\/\s*연락처\s*$/i.test(line));
  if (skippedUseful.length) {
    lines.push(`⚠️ 인식 못한 줄 ${skippedUseful.length}건: ${skippedUseful.slice(0, 3).join(' / ')}${skippedUseful.length > 3 ? ' …' : ''}`);
  }
  if (truncated) lines.push(`⚠️ 한 번에 최대 ${MAX_CONTACTS}건까지만 처리했습니다.`);

  const headline = failed === 0
    ? `✅ 연락처 ${saved}건 저장 완료`
    : `연락처 처리 결과: 저장 ${saved}건 / 확인 필요 ${failed}건`;

  return res.status(200).json(jandiResponse(`${headline}\n${lines.join('\n')}`, failed ? '#E67E22' : '#2ECC71'));
}
