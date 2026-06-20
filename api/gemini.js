import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  // 사용자가 주소창에 직접 입력해서 접속했을 때 (GET 요청)
  if (req.method === 'GET') {
    return res.status(405).json({ 
      status: "API 정상 작동 중",
      message: "이곳은 데이터를 처리하는 뒷단(API)입니다. 메인 웹페이지(index.html) 화면의 채팅창을 통해서 질문을 입력해 주세요!" 
    });
  }

  // 허용되지 않은 통신 방식 차단
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, message } = req.body || {};
    const targetPrompt = prompt || message;

    if (!targetPrompt) {
      return res.status(400).json({ error: '질문 데이터가 전송되지 않았습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: '버셀 환경 변수에 GEMINI_API_KEY가 없습니다.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(targetPrompt);
    const responseText = result.response.text();

    return res.status(200).json({ reply: responseText, text: responseText });
  } catch (error) {
    console.error('API 호출 실패:', error);
    return res.status(500).json({ error: error.message });
  }
}
