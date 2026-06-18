// Vercel Serverless Function
// 경로: /api/claude
// 역할: 클라이언트의 요청을 받아 Claude API로 포워딩 (API 키는 서버에서만 사용)

export default async function handler(req, res) {
    // CORS 헤더
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // OPTIONS 요청 처리
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // POST 요청만 허용
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { role, systemPrompt, userPrompt } = req.body;
        
        // 입력 검증
        if (!role || !systemPrompt || !userPrompt) {
            return res.status(400).json({ 
                error: 'Missing required fields: role, systemPrompt, userPrompt' 
            });
        }
        
        // 환경변수에서 API 키 읽음 (Vercel에서 설정)
        const apiKey = process.env.ANTHROPIC_API_KEY;
        
        if (!apiKey) {
            console.error('API Key not found in environment variables');
            return res.status(500).json({ 
                error: 'API Key not configured on server' 
            });
        }
        
        // Claude API 호출
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 1400,
                messages: [{
                    role: "user",
                    content: `[${role}]\n\n${systemPrompt}\n\n${userPrompt}`
                }]
            })
        });
        
        // 응답 처리
        if (!response.ok) {
            const errorData = await response.json();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({
                error: `Claude API error: ${errorData.error?.message || 'Unknown error'}`
            });
        }
        
        const data = await response.json();
        
        // 응답 추출 및 반환
        const text = data.content[0].text;
        const tokens = data.usage;
        
        return res.status(200).json({
            text: text,
            tokens: tokens,
            model: data.model
        });
        
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({
            error: `Server error: ${error.message}`
        });
    }
}