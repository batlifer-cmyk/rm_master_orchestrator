import { createSign } from 'node:crypto';

export const config = { maxDuration: 60 };

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0';
const SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || "'Master Time Data'!A:K";
const MAX_PROMPT_LENGTH = 120_000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error('Google Sheets 연결 환경 변수가 없습니다. GOOGLE_SERVICE_ACCOUNT_EMAIL과 GOOGLE_PRIVATE_KEY를 확인해 주세요.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${header}.${claims}`;
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const signature = createSign('RSA-SHA256')
    .update(unsignedToken)
    .end()
    .sign(privateKey, 'base64url');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedToken}.${signature}`,
    }),
  });
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || 'Google 서비스 계정 인증에 실패했습니다.');
  }
  return data.access_token;
}

function serialToDate(serial) {
  if (typeof serial === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const parsed = new Date(serial);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function increment(object, key) {
  if (!key) return;
  object[key] = (object[key] || 0) + 1;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function getSheetSummary() {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}/values/${encodeURIComponent(SHEET_RANGE)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || 'Google Sheets 데이터를 읽지 못했습니다.');
  }

  const rows = data.values || [];
  if (rows.length < 2) throw new Error('Master Time Data에 분석할 행이 없습니다.');

  const header = rows[0].map((value) => String(value || '').trim());
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  const required = ['Teacher', 'Date', 'Student', 'Hours', 'Rate', 'Total amount', 'Class type'];
  const missing = required.filter((name) => index[name] === undefined);
  if (missing.length) throw new Error(`시트 필수 열이 없습니다: ${missing.join(', ')}`);

  const months = new Map();
  for (const row of rows.slice(1)) {
    const date = serialToDate(row[index.Date]);
    if (!date) continue;

    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!months.has(monthKey)) {
      months.set(monthKey, {
        month: monthKey,
        records: 0,
        completedClasses: 0,
        missingHours: 0,
        hours: 0,
        teacherCost: 0,
        students: new Set(),
        teachers: {},
        classTypes: {},
      });
    }

    const bucket = months.get(monthKey);
    const teacher = String(row[index.Teacher] || '').trim();
    const student = String(row[index.Student] || '').trim();
    const classType = String(row[index['Class type']] || '').trim();
    const hours = Number(row[index.Hours]);
    const rate = Number(row[index.Rate]);
    const totalAmount = Number(row[index['Total amount']]);

    bucket.records += 1;
    if (student) bucket.students.add(student);
    increment(bucket.teachers, teacher);
    increment(bucket.classTypes, classType);

    if (Number.isFinite(hours) && hours > 0) {
      bucket.completedClasses += 1;
      bucket.hours += hours;
      if (Number.isFinite(totalAmount) && totalAmount > 0) {
        bucket.teacherCost += totalAmount;
      } else if (Number.isFinite(rate) && rate > 0) {
        bucket.teacherCost += hours * rate;
      }
    } else {
      bucket.missingHours += 1;
    }
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((item) => ({
      month: item.month,
      records: item.records,
      completedClasses: item.completedClasses,
      missingHours: item.missingHours,
      hours: round(item.hours),
      teacherCost: round(item.teacherCost),
      uniqueStudents: item.students.size,
      averageHoursPerStudent: item.students.size ? round(item.hours / item.students.size) : 0,
      teachers: item.teachers,
      classTypes: item.classTypes,
    }));
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      provider: 'openai',
      model: MODEL,
      sheetConfigured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        instructions: systemPrompt || '정확한 수치와 근거를 우선하는 한국어 비즈니스 분석가입니다.',
        input,
        max_output_tokens: 6000,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: data.error?.message || `OpenAI API 오류 (${response.status})` });
    }

    const responseText = extractOutputText(data);
    if (!responseText) return res.status(502).json({ error: 'GPT 응답에 텍스트가 없습니다.' });
    return res.status(200).json({ reply: responseText, text: responseText });
  } catch (error) {
    console.error('분석 API 실패:', error);
    return res.status(500).json({ error: error.message || '서버 오류가 발생했습니다.' });
  }
}

