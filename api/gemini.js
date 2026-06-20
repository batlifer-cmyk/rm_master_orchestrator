import { GoogleGenerativeAI } from '@google/generative-ai';

export default async function handler(req, res) {
  // 사용자가 주소창에 직접 입력해서 접속했을 때 (GET 요청)
  if (req.method === 'GET') {
    return res.status(405).json({ 
      status : "API 정상 작동 중",
      message : "이곳은 데이터를 처리하는 뒷단(API)입니다. 메인 웹페이지(index.html) 화면의 채팅창을 통해서 질문을 입력해 주세요!" 
    });
  }

  // 허용되지 않은 통신 방식 차단
  if (req.method !== 'POST') {
    return res.status(405).json({ error : 'Method Not Allowed' });
  }

  try {
    // 프론트엔드에서 보내는 구조(systemPrompt, userPrompt)를 모두 받아옵니다.
    const { prompt, message, systemPrompt, userPrompt } = req.body || {};
    
    // 실제 제미나이에 보낼 메인 질문을 결정합니다.
    const targetPrompt = userPrompt || prompt || message;

    if (!targetPrompt) {
      return res.status(400).json({ error : '질문 데이터가 전송되지 않았습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error : '버셀 환경 변수에 GEMINI_API_KEY가 없습니다.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 제미나이 모델 설정을 동적으로 구성합니다.
    const modelConfig = { model : 'gemini-1.5-flash' };
    
    // 프론트엔드에서 페르소나/역할(systemPrompt)을 보냈다면 지침으로 주입합니다.
    if (systemPrompt) {
      modelConfig.systemInstruction = systemPrompt;
    }
    
    const model = genAI.getGenerativeModel(modelConfig);

    const result = await model.generateContent(targetPrompt);
    const responseText = result.response.text();

    return res.status(200).json({ reply : responseText, text : responseText });
  } catch (error) {
    console.error('API 호출 실패:', error);
    return res.status(500).json({ error : error.message });
  }
}
