export const config = { maxDuration: 60 };

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_PROMPT_LENGTH = 120_000;

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
        max_output_tokens: 6000,
      }),
      signal: AbortSignal.timeout(55_000),
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
