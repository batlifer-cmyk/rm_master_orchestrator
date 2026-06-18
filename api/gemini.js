export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { role, systemPrompt, userPrompt } = req.body;
        const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY;

        if (!apiKey) {
            return res.status(500).json({ error: 'API Key가 Vercel 환경변수에 설정되지 않았습니다.' });
        }

      // 주소에서 v1beta 경로와 모델명 지정 방식을 가장 표준적인 형태로 수정합니다.
const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `[역할 및 페르소나]\n${role}\n\n[시스템 지침]\n${systemPrompt}\n\n[실행 요청 데이터]\n${userPrompt}`
                    }]
                }]
            })
        });

        const data = await response.json();

        // 🌟 수정 : 예외 처리 추가 (API 키 오류나 쿼터 초과 시 백엔드가 터지는 현상 방지)
        if (!data.candidates || data.candidates.length === 0) {
            const apiError = data.error?.message || "Gemini API로부터 올바른 응답을 받지 못했습니다.";
            return res.status(500).json({ error: apiError });
        }

        const text = data.candidates[0].content.parts[0].text;
        return res.status(200).json({ text: text });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
