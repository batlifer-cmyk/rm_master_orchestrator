import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export const config = { maxDuration: 300 };

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_PROMPT_LENGTH = 120_000;

// JANDI /연락처 direct-save mode.
// Valid contacts are written directly to the operating student-contact sheet.
// User-visible results are posted only to the dedicated CONSULTING Incoming Webhook.
const JCB_KEY_HASH_HEX = '5b78269cb7cdd0108201e3612294418407b177b2e91f44b43dc2684c0b12da26';
const JCB_INCOMING_IV_B64URL = 'incvG3i5MJkF8nsW';
const JCB_INCOMING_CIPHERTEXT_B64URL = 'mM3TfayRIcUQdivcM3t3TnHvEq7FqaX-ZKWkh2vz-l9_6LwmLHek03In-qh2plO_75c6QXMuGsFyrP3ooZQwUMf3ko6eIvV4hmEghcRC5PK2zw';
const JCB_INCOMING_TAG_B64URL = 'Zt9KJbh9btEpavja1Agiig';
const JCB_SPREADSHEET_ID = '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE';
const JCB_SHEET_NAME = '학생연락처';
const JCB_MANUAL_RANGE = `'${JCB_SHEET_NAME}'!F:G`;
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

function jcbDecryptIncomingUrl(key) {
  const iv = Buffer.from(JCB_INCOMING_IV_B64URL, 'base64url');
  const ciphertext = Buffer.from(JCB_INCOMING_CIPHERTEXT_B64URL, 'base64url');
  const tag = Buffer.from(JCB_INCOMING_TAG_B64URL, 'base64url');
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

function jcbNormalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function jcbCleanName(prefix) {
  return String(prefix || '')
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '')
    .replace(/^\s*\/\s*연락처(?:\s+|$)/i, '')
    .replace(/^[\s'"“”‘’]+|[\s'"“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jcbParseContacts(rawText) {
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
    const dedupeKey = `${name}\u0000${jcbNormalizePhone(phone)}`;
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

function jcbSilentAck(res, details = {}) {
  // Do not return JANDI's { body: ... } response shape. This prevents
  // Outgoing Webhook response messages from appearing in the configured JANDI room.
  return res.status(200).json({ ok: true, ...details });
}

async function jcbPostIncoming(incomingUrl, body, color = '#BBCBCD') {
  const response = await fetch(incomingUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, connectColor: color }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`JANDI_INCOMING_${response.status}`);
  }
}

async function jcbGetSheetsAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS_MISSING');
  }

  const auth = new GoogleAuth({
    credentials: {
      client_email: email,
      private_key: rawKey.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
  if (!token) throw new Error('GOOGLE_SHEETS_TOKEN_FAILED');
  return token;
}

async function jcbSheetsRequest(token, path, options = {}) {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${JCB_SPREADSHEET_ID}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.error?.message || `Google Sheets API ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function jcbReadManualContacts(token) {
  const encoded = encodeURIComponent(JCB_MANUAL_RANGE);
  const data = await jcbSheetsRequest(
    token,
    `/values/${encoded}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
  );
  const values = Array.isArray(data.values) ? data.values : [];
  const headerName = String(values[0]?.[0] || '').trim();
  const headerPhone = String(values[0]?.[1] || '').trim();
  if (headerName !== '학생명(수동입력키)' || headerPhone !== '전화번호') {
    throw new Error('CONTACT_SHEET_HEADER_MISMATCH');
  }
  return values;
}

async function jcbAppendContacts(token, contacts) {
  if (!contacts.length) return null;
  const encoded = encodeURIComponent(JCB_MANUAL_RANGE);
  return jcbSheetsRequest(
    token,
    `/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE&includeValuesInResponse=true`,
    {
      method: 'POST',
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: contacts.map(contact => [contact.name, contact.phone]),
      }),
    },
  );
}

function jcbExistingPairSet(values) {
  const set = new Set();
  for (const row of values.slice(1)) {
    const name = String(row?.[0] || '').trim();
    const phone = jcbNormalizePhone(row?.[1]);
    if (name && phone) set.add(`${name}\u0000${phone}`);
  }
  return set;
}

function jcbSafeErrorCode(error) {
  const msg = String(error?.message || error || 'UNKNOWN');
  if (/permission|forbidden|403/i.test(msg)) return 'SHEET_PERMISSION';
  if (/header/i.test(msg)) return 'SHEET_HEADER';
  if (/credential|token/i.test(msg)) return 'GOOGLE_AUTH';
  if (/JANDI_INCOMING/i.test(msg)) return 'JANDI_INCOMING';
  return 'SAVE_FAILED';
}

async function handleJandiContactBatch(req, res) {
  const key = jcbAuthorized(req);
  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  let incomingUrl;
  try {
    incomingUrl = jcbDecryptIncomingUrl(key);
  } catch (error) {
    console.error('jandi-contact incoming decrypt failed', error);
    return res.status(500).json({ error: 'incoming_config_error' });
  }

  if (req.method === 'GET') {
    if (jcbAsString(req.query?.notify) === '1') {
      try {
        await jcbPostIncoming(
          incomingUrl,
          '✅ /연락처 저장결과 전용 Webhook 연결이 완료되었습니다.',
          '#2ECC71',
        );
        return res.status(200).json({ ok: true, notificationSent: true });
      } catch (error) {
        console.error('jandi-contact notify test failed', error);
        return res.status(502).json({ ok: false, error: jcbSafeErrorCode(error) });
      }
    }

    if (jcbAsString(req.query?.diagnostic) === '1') {
      try {
        const token = await jcbGetSheetsAccessToken();
        const values = await jcbReadManualContacts(token);
        return res.status(200).json({
          ok: true,
          service: 'jandi-contact-direct-save',
          sheetAccess: true,
          existingRows: Math.max(0, values.length - 1),
          incomingConfigured: true,
        });
      } catch (error) {
        console.error('jandi-contact diagnostic failed', error);
        return res.status(200).json({
          ok: false,
          service: 'jandi-contact-direct-save',
          sheetAccess: false,
          incomingConfigured: true,
          error: jcbSafeErrorCode(error),
        });
      }
    }

    return res.status(200).json({
      ok: true,
      service: 'jandi-contact-direct-save',
      maxContacts: JCB_MAX_CONTACTS,
      responseMode: 'silent-outgoing-dedicated-incoming-confirmation',
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
    return jcbSilentAck(res, { ignored: true, reason: 'wrong_keyword' });
  }

  const { contacts, skipped, truncated } = jcbParseContacts(rawText || fullText);

  if (!contacts.length) {
    try {
      await jcbPostIncoming(
        incomingUrl,
        '⚠️ 이름과 010 전화번호를 찾지 못했습니다. 예: /연락처 김민수 010-1234-5678',
        '#E67E22',
      );
    } catch (error) {
      console.error('jandi-contact invalid-input notification failed', error);
    }
    return jcbSilentAck(res, { processed: 0, skipped: skipped.length });
  }

  try {
    const token = await jcbGetSheetsAccessToken();
    const existingValues = await jcbReadManualContacts(token);
    const existingPairs = jcbExistingPairSet(existingValues);

    const newContacts = [];
    const duplicateContacts = [];
    for (const contact of contacts) {
      const pair = `${contact.name}\u0000${jcbNormalizePhone(contact.phone)}`;
      if (existingPairs.has(pair)) {
        duplicateContacts.push(contact);
      } else {
        newContacts.push(contact);
        existingPairs.add(pair);
      }
    }

    const appendResult = await jcbAppendContacts(token, newContacts);
    const updatedRange = appendResult?.updates?.updatedRange || '';

    const report = [];
    if (newContacts.length) {
      report.push(`✅ 연락처 ${newContacts.length}건 저장 완료`);
      report.push(...newContacts.map(contact => `${contact.name} ${contact.phone}`));
    } else {
      report.push('✅ 새로 저장할 연락처가 없습니다.');
    }
    if (duplicateContacts.length) {
      report.push(`↩️ 이미 등록된 동일 연락처 ${duplicateContacts.length}건은 건너뛰었습니다.`);
    }
    if (skipped.length) {
      report.push(`⚠️ 인식하지 못한 줄 ${skipped.length}건`);
    }
    if (truncated) {
      report.push(`⚠️ 한 번에 최대 ${JCB_MAX_CONTACTS}건까지만 처리했습니다.`);
    }

    await jcbPostIncoming(incomingUrl, report.join('\n'), '#2ECC71');

    return jcbSilentAck(res, {
      processed: contacts.length,
      saved: newContacts.length,
      duplicates: duplicateContacts.length,
      skipped: skipped.length,
      truncated,
      updatedRange,
    });
  } catch (error) {
    const safeCode = jcbSafeErrorCode(error);
    console.error('jandi-contact direct save failed', safeCode, error);
    try {
      await jcbPostIncoming(
        incomingUrl,
        `⚠️ 연락처 저장에 실패했습니다. 운영 확인 코드: ${safeCode}`,
        '#E74C3C',
      );
    } catch (notifyError) {
      console.error('jandi-contact failure notification failed', notifyError);
    }
    return jcbSilentAck(res, { processed: contacts.length, saved: 0, error: safeCode });
  }
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
