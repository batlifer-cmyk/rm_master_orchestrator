import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export const config = { maxDuration: 300 };

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_PROMPT_LENGTH = 120_000;

// JANDI /연락처 batch compatibility mode.
// The existing Apps Script endpoint stays the source of truth for actual writes.
const JCB_KEY_HASH_HEX = '5b78269cb7cdd0108201e3612294418407b177b2e91f44b43dc2684c0b12da26';
const JCB_UPSTREAM_IV_B64URL = 'DRFUXzJO8VrUoxT7';
const JCB_UPSTREAM_CIPHERTEXT_B64URL = 'uqpFTq91VTDm_lhGE65dm5Trb9OTVKkL8Lgzi4T4faN9Mg_bXPw0hlTaD_VLKZWSXj47OhuViR-4Yc_ITf3RnDQ2l8AKHjS0YjTeVauSq_EuMGRF3CY5gDGiQnFQtNnpMVR9ZqILzpranLbuyNsiKg';
const JCB_UPSTREAM_TAG_B64URL = 'C0NUyT7JZdN5cJVbe-_5YQ';
const JCB_MAX_CONTACTS = 20;
const JCB_PHONE_RE = /(?<!\d)(01[016789])[\s-]?(\d{3,4})[\s-]?(\d{4})(?!\d)/g;

function jcbAsString(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function jcbDecodeKey(raw) {
  try {
    const key = Buffer.from(jcbAsString(raw), 'base64url');
    return key.length === 32 ? key : null;
  } catch (_) {
    return null;
  }
}

function jcbAuthorized(req) {
  const key = jcbDecodeKey(req.query?.k);
  if (!key) return null;
  const actual = createHash('sha256').update(key).digest();
  const expected = Buffer.from(JCB_KEY_HASH_HEX, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return key;
}

function jcbDecryptUpstream(key) {
  const iv = Buffer.from(JCB_UPSTREAM_IV_B64URL, 'base64url');
  const ciphertext = Buffer.from(JCB_UPSTREAM_CIPHERTEXT_B64URL, 'base64url');
  const tag = Buffer.from(JCB_UPSTREAM_TAG_B64URL, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function jcbNormalizePayloadBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

function jcbStripCommand(text) {
  return String(text || '')
    .replace(/^\s*\/\s*연락처(?:\s+|$)/i, '')
    .trim();
}

function jcbFormatPhone(groups) {
  const [, prefix, middle, last] = groups;
  return `${prefix}-${middle}-${last}`;
}

function jcbCleanName(prefix) {
  return String(prefix || '')
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '')
    .replace(/^\s*\/\s*연락처(?:\s+|$)/i, '')
    .replace(/^[\s'"“”‘’]+|[\s'"“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jcbParseBatch(rawText) {
  const text = jcbStripCommand(rawText);
  const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const contacts = [];
  const skipped = [];
  const seen = new Set();

  for (const originalLine of lines) {
    const line = jcbStripCommand(originalLine);
    JCB_PHONE_RE.lastIndex = 0;
    const match = JCB_PHONE_RE.exec(line);
    if (!match) {
      skipped.push(originalLine);
      continue;
    }

    const name = jcbCleanName(line.slice(0, match.index));
    if (!name) {
      skipped.push(originalLine);
      continue;
    }

    const phone = jcbFormatPhone(match);
    const dedupeKey = `${name}\u0000${phone.replace(/\D/g, '')}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    contacts.push({ name, phone });
  }

  return {
    contacts: contacts.slice(0, JCB_MAX_CONTACTS),
    skipped,
    truncated: contacts.length > JCB_MAX_CONTACTS,
  };
}

function jcbCountPhoneCandidates(rawText) {
  const text = String(rawText || '');
  const matches = text.match(/(?<!\d)01[016789][\s-]?\d{3,4}[\s-]?\d{4}(?!\d)/g);
  return matches ? matches.length : 0;
}

async function jcbCallUpstream(upstream, payload) {
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

async function jcbMapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = {
          ok: false,
          status: 0,
          body: error?.message || 'upstream_error',
          json: null,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function jcbResponse(body, color = '#BBCBCD') {
  return { body, connectColor: color };
}

async function handleJandiContactBatch(req, res) {
  const key = jcbAuthorized(req);
  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'jandi-contact-batch',
      maxContacts: JCB_MAX_CONTACTS,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const payload = jcbNormalizePayloadBody(req);
  const keyword = String(payload.keyword || '').replace(/^\//, '').trim();
  const fullText = String(payload.text || '');
  const dataText = String(payload.data || '');
  const rawText = dataText || jcbStripCommand(fullText);

  if (keyword && keyword !== '연락처') {
    return res.status(400).json(jcbResponse('이 주소는 /연락처 전용입니다.', '#E67E22'));
  }

  let upstream;
  try {
    upstream = jcbDecryptUpstream(key);
  } catch (error) {
    console.error('jandi-contact-batch upstream decrypt failed', error);
    return res.status(500).json(jcbResponse('연락처 연결 설정을 읽지 못했습니다.', '#E74C3C'));
  }

  const candidateCount = jcbCountPhoneCandidates(rawText || fullText);

  // 0~1건이면 기존 Apps Script에 원문 그대로 전달해 기존 동작을 보존한다.
  if (candidateCount <= 1) {
    try {
      const upstreamResult = await jcbCallUpstream(upstream, payload);
      if (upstreamResult.json && typeof upstreamResult.json === 'object') {
        return res.status(upstreamResult.status || 200).json(upstreamResult.json);
      }
      return res.status(upstreamResult.status || 200).send(upstreamResult.body || '');
    } catch (error) {
      console.error('jandi-contact-batch single passthrough failed', error);
      return res.status(502).json(jcbResponse('기존 연락처 저장 서버 호출에 실패했습니다.', '#E74C3C'));
    }
  }

  const { contacts, skipped, truncated } = jcbParseBatch(rawText || fullText);
  if (!contacts.length) {
    try {
      const upstreamResult = await jcbCallUpstream(upstream, payload);
      if (upstreamResult.json && typeof upstreamResult.json === 'object') {
        return res.status(upstreamResult.status || 200).json(upstreamResult.json);
      }
      return res.status(upstreamResult.status || 200).send(upstreamResult.body || '');
    } catch (error) {
      return res.status(502).json(jcbResponse('연락처 저장 서버 호출에 실패했습니다.', '#E74C3C'));
    }
  }

  const results = await jcbMapWithConcurrency(contacts, 3, async contact => {
    const oneLine = `${contact.name} ${contact.phone}`;
    const forwarded = {
      ...payload,
      keyword: payload.keyword || '연락처',
      text: `/연락처 ${oneLine}`,
      data: oneLine,
    };
    return jcbCallUpstream(upstream, forwarded);
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

  const skippedUseful = skipped.filter(
    line => !/^\s*\/\s*연락처\s*$/i.test(line),
  );
  if (skippedUseful.length) {
    lines.push(
      `⚠️ 인식 못한 줄 ${skippedUseful.length}건: ${skippedUseful.slice(0, 3).join(' / ')}${skippedUseful.length > 3 ? ' …' : ''}`,
    );
  }
  if (truncated) {
    lines.push(`⚠️ 한 번에 최대 ${JCB_MAX_CONTACTS}건까지만 처리했습니다.`);
  }

  const headline = failed === 0
    ? `✅ 연락처 ${saved}건 저장 완료`
    : `연락처 처리 결과: 저장 ${saved}건 / 확인 필요 ${failed}건`;

  return res.status(200).json(
    jcbResponse(`${headline}\n${lines.join('\n')}`, failed ? '#E67E22' : '#2ECC71'),
  );
}

async function getSheetSummary() {
  const url = process.env.GOOGLE_SHEETS_WEB_APP_URL;
  const secret = process.env.GOOGLE_SHEETS_WEB_APP_SECRET;

  if (!url || !secret) {
    throw new Error('GOOGLE_SHEETS_WEB_APP_URL 또는 GOOGLE_SHEETS_WEB_APP_SECRET가 없습니다.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.error || `Google Sheets 집계 API 오류 (${response.status})`);
  }
  return data.months || [];
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
}

export default async function handler(req, res) {
  if (jcbAsString(req.query?.mode) === 'jandi-contact-batch') {
    return handleJandiContactBatch(req, res);
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      provider: 'openai',
      model: MODEL,
      sheetConfigured: Boolean(
        process.env.GOOGLE_SHEETS_WEB_APP_URL &&
        process.env.GOOGLE_SHEETS_WEB_APP_SECRET
      ),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, message, systemPrompt, userPrompt, includeSheetData } = req.body || {};
    const targetPrompt = userPrompt || prompt || message;

    if (typeof targetPrompt !== 'string' || !targetPrompt.trim()) {
      return res.status(400).json({ error: '분석 질문을 입력해 주세요.' });
    }
    if (targetPrompt.length > MAX_PROMPT_LENGTH) {
      return res.status(413).json({ error: '요청 내용이 너무 깁니다.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY가 없습니다.' });

    let input = targetPrompt.trim();
    if (includeSheetData) {
      const summary = await getSheetSummary();
      input = `${input}\n\n[Master Time Data 월별 집계 - 학생 이름 제거됨]\n${JSON.stringify(summary)}\n\n` +
        '[해석 규칙]\n' +
        '- records는 원본 행 수, completedClasses는 Hours가 숫자인 유효 수업 행 수입니다.\n' +
        '- teacherCost는 Total amount를 우선 사용하고 없으면 Hours x Rate로 계산했습니다.\n' +
        '- 이 탭에는 광고비, 문의, 상담, 등록매출 데이터가 없으므로 ROAS, CPA, 문의전환율을 임의로 만들지 마세요.\n' +
        '- 비교 기간의 절대값, 증감값, 증감률을 계산하고 데이터 한계를 명시하세요.';
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: systemPrompt || '정확한 수치와 근거를 우선하는 한국어 비즈니스 분석가입니다.',
        input,
        reasoning: { effort: 'none' },
        text: { verbosity: 'medium' },
        max_output_tokens: 3000,
      }),
      signal: AbortSignal.timeout(280_000),
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error: data.error?.message || `OpenAI API 오류 (${response.status})`,
      });
    }

    const responseText = extractOutputText(data);
    if (!responseText) return res.status(502).json({ error: 'GPT 응답에 텍스트가 없습니다.' });
    return res.status(200).json({ reply: responseText, text: responseText });
  } catch (error) {
    console.error('분석 API 실패:', error);
    return res.status(500).json({ error: error.message || '서버 오류가 발생했습니다.' });
  }
}
