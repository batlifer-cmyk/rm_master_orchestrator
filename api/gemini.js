import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  // POST 요청이 아닌 경우 차단
  if (req.method !== 'POST') {
    return res.status(405).json({ error : 'Method Not Allowed' });
  }

  try {
    // 프론트엔드에서 보낸 본문 데이터에서 prompt 또는 message 추출
    const { prompt, message } = req.body;
    const targetPrompt = prompt || message;

    if (!targetPrompt) {
      return res.status(400).json({ error : 'Prompt or message is required' });
    }

    // 버셀 환경 변수에 등록된 API 키 가져오기
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error : 'GEMINI_API_KEY가 버셀 환경 변수에 설정되지 않았습니다.' });
    }

    // Gemini API 초기화 및 모델 설정
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model : 'gemini-1.5-flash' });

    // 텍스트 생성 요청 실행
    const result = await model.generateContent(targetPrompt);
    const responseText = result.response.text();

    // 프론트엔드가 요구하는 다양한 응답 형태에 맞춰 결과 반환
    return res.status(200).json({ reply : responseText, text : responseText });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error : error.message });
  }
}
