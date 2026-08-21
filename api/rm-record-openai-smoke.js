export const config = { maxDuration: 120 };

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  return (data?.output || []).flatMap(x => x.content || []).filter(x => ['output_text', 'text'].includes(x.type)).map(x => x.text || '').join('').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY missing' });

  try {
    const speech = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        input: 'Hello, this is Ryan Members. This is a short transcription smoke test.',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!speech.ok) throw new Error(`TTS ${speech.status}: ${(await speech.text()).slice(0,300)}`);
    const audio = new Blob([await speech.arrayBuffer()], { type: 'audio/mpeg' });

    const form = new FormData();
    form.append('file', audio, 'smoke.mp3');
    form.append('model', 'gpt-4o-transcribe-diarize');
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
    const transcription = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const transcriptionText = await transcription.text();
    if (!transcription.ok) throw new Error(`Transcription ${transcription.status}: ${transcriptionText.slice(0,300)}`);
    const transcript = JSON.parse(transcriptionText);

    const analysisModel = process.env.RM_RECORD_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
    const analysisResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: analysisModel,
        input: `Summarize this transcript in one short sentence: ${transcript.text || ''}`,
        text: { format: { type: 'json_schema', name: 'smoke_result', strict: true, schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, summary: { type: 'string' } }, required: ['ok','summary'] } } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const analysisData = await analysisResponse.json();
    if (!analysisResponse.ok) throw new Error(`Responses ${analysisResponse.status}: ${JSON.stringify(analysisData.error || analysisData).slice(0,300)}`);
    const structured = JSON.parse(outputText(analysisData));

    return res.status(200).json({
      tts: true,
      diarization: true,
      transcript: transcript.text || '',
      segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0,
      speakers: [...new Set((transcript.segments || []).map(x => x.speaker).filter(Boolean))],
      analysisModel,
      structuredOutput: structured,
    });
  } catch (error) {
    console.error('RM Record OpenAI smoke test failed:', error);
    return res.status(500).json({ error: error.message || 'smoke test failed' });
  }
}
