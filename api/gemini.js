const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, message } = req.body;
    const targetPrompt = prompt || message;

    if (!targetPrompt) {
      return res.status(400).json({ error: 'Prompt or message is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(targetPrompt);
    const responseText = result.response.text();

    return res.status(200).json({ reply: responseText, text: responseText });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
