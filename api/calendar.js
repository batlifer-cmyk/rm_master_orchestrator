import { createSign } from 'node:crypto';

export const config = { maxDuration: 30 };

const ALLOWED_ORIGINS = new Set([
  'https://batlifer-cmyk.github.io',
  'https://rm-master-orchestrator.vercel.app',
]);

const CALENDARS = Object.freeze({
  matthew: {
    name: 'Matthew Moon',
    calendarId: 'matthew.g.mun@gmail.com',
    source: 'RM 매튜 (강사소유 원본)',
  },
  david: {
    name: 'David Park',
    calendarId: 'parkdavid0211@gmail.com',
    source: 'RM 데이빗 (강사소유 원본)',
  },
  paul: {
    name: 'Paul Oh',
    calendarId: '78705a8de54b56ea1c21af40a1b8c80b468dcdc82b1e92d2943db0d121ac4bec@group.calendar.google.com',
    source: 'RM 폴',
  },
  jenna: {
    name: 'Jenna Kim',
    calendarId: '6bfaa96f9c8bf215a51189ab58c6426586b77751a85c898365d2f6ffb86eb73f@group.calendar.google.com',
    source: 'RM 제나',
  },
  dean: {
    name: 'Dean Jeong',
    calendarId: '2f1dff2664bb6fd9c5de5bf31aa0dbc87e680ae675fc474302f975a78b39bf64@group.calendar.google.com',
    source: 'RM 딘',
  },
  campbell: {
    name: 'Campbell Soutter',
    calendarId: '35232bdfdf3dd69e8f398023d262ea69b408f431736141789e363b4eb92eb86e@group.calendar.google.com',
    source: 'RM 캠벨',
  },
});

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY 미설정');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const key = rawKey.replace(/\\n/g, '\n');
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(key, 'base64url');

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await tokenResponse.json();
  if (!tokenResponse.ok || !data.access_token) {
    // Compatibility with Google's documented JWT bearer grant value.
    const retryResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const retryData = await retryResponse.json();
    if (!retryResponse.ok || !retryData.access_token) {
      throw new Error(retryData.error_description || retryData.error || data.error_description || data.error || 'Google 서비스계정 토큰 발급 실패');
    }
    return retryData.access_token;
  }
  return data.access_token;
}

function parseInput(req) {
  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const rawIds = Array.isArray(src.instructors)
    ? src.instructors
    : String(src.instructors || '').split(',');
  const instructors = [...new Set(rawIds.map(v => String(v).trim().toLowerCase()).filter(Boolean))]
    .filter(id => CALENDARS[id])
    .slice(0, 10);
  return {
    instructors: instructors.length ? instructors : Object.keys(CALENDARS).filter(id => id !== 'campbell'),
    timeMin: String(src.timeMin || '').trim(),
    timeMax: String(src.timeMax || '').trim(),
    timezone: String(src.timezone || 'Asia/Seoul').trim(),
  };
}

function validateWindow(timeMin, timeMax) {
  const a = new Date(timeMin);
  const b = new Date(timeMax);
  if (!timeMin || !timeMax || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    throw new Error('timeMin/timeMax는 RFC3339 날짜시간이어야 합니다.');
  }
  if (b <= a) throw new Error('timeMax는 timeMin보다 뒤여야 합니다.');
  const days = (b - a) / 86400000;
  if (days > 70) throw new Error('한 번에 조회 가능한 기간은 최대 70일입니다.');
}

async function listTimedBusyEvents(token, id, timeMin, timeMax, timezone) {
  const meta = CALENDARS[id];
  const busy = [];
  let pageToken = '';
  try {
    do {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        timeZone: timezone,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
        fields: 'items(status,transparency,start,end),nextPageToken',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(meta.calendarId)}/events?${params}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      if (!response.ok) {
        return {
          id,
          name: meta.name,
          source: meta.source,
          ok: false,
          busy: [],
          errors: [{ reason: data?.error?.errors?.[0]?.reason || `http_${response.status}` }],
        };
      }
      for (const event of data.items || []) {
        if (!event || event.status === 'cancelled' || event.transparency === 'transparent') continue;
        // RM uses all-day events as availability notes. Only timed events block lessons.
        if (!event.start?.dateTime || !event.end?.dateTime) continue;
        busy.push({ start: event.start.dateTime, end: event.end.dateTime });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return { id, name: meta.name, source: meta.source, ok: true, busy, errors: [] };
  } catch (error) {
    return {
      id,
      name: meta.name,
      source: meta.source,
      ok: false,
      busy: [],
      errors: [{ reason: error.message || 'calendar_read_failed' }],
    };
  }
}

async function queryCalendars({ instructors, timeMin, timeMax, timezone }) {
  validateWindow(timeMin, timeMax);
  const token = await getGoogleAccessToken();
  const calendars = await Promise.all(
    instructors.map(id => listTimedBusyEvents(token, id, timeMin, timeMax, timezone)),
  );
  return {
    ok: calendars.every(x => x.ok),
    timeMin,
    timeMax,
    timezone,
    provider: 'google-calendar-events-sanitized',
    calendars,
  };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const input = parseInput(req);
    if (!input.timeMin || !input.timeMax) {
      return res.status(200).json({
        status: 'ok',
        serviceAccountConfigured: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
        serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
        provider: 'google-calendar-events-sanitized',
        instructors: Object.entries(CALENDARS).map(([id, value]) => ({ id, name: value.name, source: value.source })),
      });
    }
    const result = await queryCalendars(input);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Calendar events API failed:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Calendar API 오류',
      googleStatus: error.googleStatus || null,
      googleReason: error.googleReason || null,
    });
  }
}
