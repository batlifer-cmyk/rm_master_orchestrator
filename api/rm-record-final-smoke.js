import { put, get, del } from '@vercel/blob';

export const config = { maxDuration: 120 };

const SECRET = 'E2yP7KxQn3vR8mJ5cT1wL9sF4hA6uD0b';

function extractText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  return (data?.output || []).flatMap(x => x.content || []).filter(x => ['output_text', 'text'].includes(x.type) && typeof x.text === 'string').map(x => x.text).join('').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (req.query?.secret !== SECRET) return res.status(404).json({ error: 'Not Found' });

  const result = {
    blobStoreIdPresent: Boolean(process.env.BLOB_STORE_ID),
    legacyBlobTokenPresent: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    openaiPresent: Boolean(process.env.OPENAI_API_KEY),
    blobWrite: false,
    blobRead: false,
    blobPrivate: false,
    tts: false,
    diarization: false,
    structuredAnalysis: false,
  };

  let blobUrl = null;
  try {
    const testBody = `rm-record-smoke-${Date.now()}`;
    const stored = await put(`rm-record/smoke/${crypto.randomUUID()}.txt`, testBody, {
      access: 'private', addRandomSuffix: false, contentType: 'text/plain; charset=utf-8',
    });
    blobUrl = stored.url;
    result.blobWrite = true;
    result.blobPrivate = Boolean(stored.pathname);

    const fetched = await get(stored.url, { access: 'private', useCache: false });
    if (!fetched || fetched.statusCode !== 200 || !fetched.stream) throw new Error('Private Blob read failed');
    const readText = await new Response(fetched.stream).text();
    result.blobRead = readText === testBody;

    const speech = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: 'Hello. This is a short Ryan Members transcription test.', response_format: 'mp3' }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!speech.ok) throw new Error(`TTS failed ${speech.status}: ${(await speech.text()).slice(0,200)}`);
    const audio = new Blob([await speech.arrayBuffer()], { type: 'audio/mpeg' });
    result.tts = audio.size > 0;

    const form = new FormData();
    form.append('file', audio, 'smoke.mp3');
    form.append('model', 'gpt-4o-transcribe-diarize');
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(60_000),
    });
    const trText = await tr.text();
    if (!tr.ok) throw new Error(`Transcription failed ${tr.status}: ${trText.slice(0,300)}`);
    const transcript = JSON.parse(trText);
    result.diarization = Array.isArray(transcript.segments) && transcript.segments.length > 0;
    result.transcriptPreview = String(transcript.text || transcript.segments?.map(s => s.text).join(' ') || '').slice(0,160);
    result.segmentCount = Array.isArray(transcript.segments) ? transcript.segments.length : 0;

    const model = process.env.RM_RECORD_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
    const ar = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        input: `Return whether this is a transcription test and summarize it briefly: ${result.transcriptPreview}`,
        text: { format: { type: 'json_schema', name: 'rm_record_smoke', strict: true, schema: {
          type: 'object', additionalProperties: false,
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
          required: ['ok','summary']
        } } }
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const analysis = await ar.json();
    if (!ar.ok) throw new Error(`Analysis failed ${ar.status}: ${JSON.stringify(analysis.error || analysis).slice(0,300)}`);
    const parsed = JSON.parse(extractText(analysis));
    result.structuredAnalysis = parsed.ok === true && typeof parsed.summary === 'string';
    result.analysisModel = model;
    result.analysisSummary = parsed.summary;

    return res.status(200).json({ ok: result.blobWrite && result.blobRead && result.tts && result.diarization && result.structuredAnalysis, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, ...result, error: error.message || 'Smoke test failed' });
  } finally {
    if (blobUrl) { try { await del(blobUrl); } catch {} }
  }
}
