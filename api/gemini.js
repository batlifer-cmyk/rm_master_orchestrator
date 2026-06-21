export const config = {
  maxDuration: 60,
};

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_PROMPT_LENGTH = 120_000;

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
      configured: Boolean(process.env.OPENAI_API_KEY),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, message, systemPrompt, userPrompt } = req.body || {};
    const targetPrompt = userPrompt || prompt || message;

    if (typeof targetPrompt !== 'string' || !targetPrompt.trim()) {
      return res.status(400).json({ error: '질문 데이터가 전송되지 않았습니다.' });
    }

    if (targetPrompt.length > MAX_PROMPT_LENGTH) {
      return res.status(413).json({
        error: `입력 데이터가 너무 큽니다. ${MAX_PROMPT_LENGTH.toLocaleString()}자 이하로 줄여 주세요.`,
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'Vercel Settings > Environment Variables에 OPENAI_API_KEY를 등록하고 Production으로 다시 배포해 주세요.',
      });
    }

    const requestBody = {
      model: MODEL,
      input: targetPrompt,
      max_output_tokens: 6000,
    };

    if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
      requestBody.instructions = systemPrompt.trim();
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(55_000),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI API error:', response.status, data?.error?.type);
      return res.status(502).json({
        error: data?.error?.message || `OpenAI API 요청에 실패했습니다. (HTTP ${response.status})`,
      });
    }

    const responseText = extractOutputText(data);

    if (!responseText) {
      return res.status(502).json({ error: 'GPT 응답에 텍스트가 없습니다.' });
    }

    return res.status(200).json({ reply: responseText, text: responseText });
  } catch (error) {
    const message =
      error?.name === 'TimeoutError'
        ? 'GPT 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
        : error?.message || '알 수 없는 서버 오류가 발생했습니다.';

    console.error('OpenAI API 호출 실패:', error);
    return res.status(500).json({ error: message });
  }
}
