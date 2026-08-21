import { del, get, put } from '@vercel/blob';
import { parseJsonBody, requirePost, requireRmRecordAuth } from '../lib/rm-record-auth.js';

export const config = { maxDuration: 300 };

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const ANALYSIS_MODEL = process.env.RM_RECORD_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    speaker_map: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { speaker: { type: 'string' }, label: { type: 'string' } },
        required: ['speaker', 'label'],
      },
    },
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    next_actions: { type: 'array', items: { type: 'string' } },
    consultation: {
      type: 'object', additionalProperties: false,
      properties: {
        goal: { type: 'string' }, current_level: { type: 'string' }, schedule: { type: 'string' },
        concerns: { type: 'array', items: { type: 'string' } }, price_reaction: { type: 'string' },
        registration_signal: { type: 'string' },
      },
      required: ['goal', 'current_level', 'schedule', 'concerns', 'price_reaction', 'registration_signal'],
    },
    lesson: {
      type: 'object', additionalProperties: false,
      properties: {
        topics: { type: 'array', items: { type: 'string' } },
        corrections: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { original: { type: 'string' }, corrected: { type: 'string' }, reason: { type: 'string' } },
            required: ['original', 'corrected', 'reason'],
          },
        },
        vocabulary: { type: 'array', items: { type: 'string' } },
        grammar_focus: { type: 'array', items: { type: 'string' } },
        homework: { type: 'array', items: { type: 'string' } },
      },
      required: ['topics', 'corrections', 'vocabulary', 'grammar_focus', 'homework'],
    },
  },
  required: ['title', 'speaker_map', 'summary', 'key_points', 'next_actions', 'consultation', 'lesson'],
};

function kindLabel(kind) {
  return kind === 'phone' ? '전화상담' : kind === 'in_person' ? '대면상담' : '수업';
}

function safeExtension(name, contentType) {
  const match = String(name || '').match(/\.([a-z0-9]{2,5})$/i);
  if (match) return `.${match[1].toLowerCase()}`;
  if (contentType.includes('webm')) return '.webm';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return '.m4a';
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('ogg')) return '.ogg';
  return '.audio';
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  return (data?.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => (item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
}

async function readChunks(chunks, contentType) {
  const sorted = [...chunks].sort((a, b) => Number(a.index) - Number(b.index));
  if (!sorted.length || sorted.length > 100) throw new Error('업로드 조각 수가 올바르지 않습니다.');

  const parts = [];
  let total = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const chunk = sorted[i];
    if (Number(chunk.index) !== i || !chunk.url) throw new Error('업로드 조각이 누락되었거나 순서가 올바르지 않습니다.');
    const stored = await get(chunk.url, { access: 'private', useCache: false });
    if (!stored || stored.statusCode !== 200 || !stored.stream) throw new Error(`업로드 조각 ${i + 1}을 읽지 못했습니다.`);
    const bytes = await new Response(stored.stream).arrayBuffer();
    total += bytes.byteLength;
    if (total > MAX_AUDIO_BYTES) throw new Error('음성파일은 최대 24MB까지 전사할 수 있습니다.');
    parts.push(bytes);
  }
  return new Blob(parts, { type: contentType || 'application/octet-stream' });
}

async function transcribe(audio, filename) {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', 'gpt-4o-transcribe-diarize');
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(280_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`전사 실패 (${response.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function analyze({ kind, subjectName, staffName, note, transcript }) {
  const segmentText = (transcript.segments || []).map((s) => `[${s.speaker}] ${s.text}`).join('\n');
  const instructions = `You analyze Ryan Members 1:1 English academy conversations.\nRules:\n- Never rewrite or translate the raw transcript.\n- Korean/English code-switching is intentional data. Preserve quoted student utterances exactly.\n- Infer speaker identities only when supported; otherwise use 화자 A, 화자 B, etc.\n- For consultations, extract only information actually stated; unknown fields must be empty.\n- For lessons, identify student errors only when reasonably clear; never invent errors.\n- Keep summaries factual.\n- registration_signal must be one of 높음, 중간, 낮음, 판단불가, or empty.\n- Return structured JSON only.`;
  const input = `기록 유형: ${kindLabel(kind)}\n대상자/학생: ${subjectName || '미입력'}\n상담자/강사: ${staffName || '미입력'}\n메모: ${note || '없음'}\n\n화자분리 원문:\n${segmentText}`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      instructions,
      input,
      text: { format: { type: 'json_schema', name: 'rm_record_analysis', strict: true, schema: ANALYSIS_SCHEMA } },
    }),
    signal: AbortSignal.timeout(280_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `AI 분석 실패 (${response.status})`);
  const output = extractResponseText(data);
  if (!output) throw new Error('AI 분석 결과가 비어 있습니다.');
  return JSON.parse(output);
}

async function cleanup(chunks) {
  const urls = (chunks || []).map((c) => c.url).filter(Boolean);
  if (!urls.length) return;
  try { await del(urls); } catch (error) { console.error('RM Record temp cleanup failed:', error); }
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireRmRecordAuth(req, res)) return;
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OpenAI 연결이 설정되지 않았습니다.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'Private Blob 스토리지가 아직 연결되지 않았습니다.' });

  const body = parseJsonBody(req);
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  const kind = String(body.kind || '');
  if (!['phone', 'in_person', 'lesson'].includes(kind) || !body.uploadId || !chunks.length || body.consentConfirmed !== true) {
    return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
  }
  if (Number(body.size || 0) > MAX_AUDIO_BYTES) {
    await cleanup(chunks);
    return res.status(413).json({ error: '음성파일은 최대 24MB까지 전사할 수 있습니다.' });
  }

  try {
    const contentType = String(body.contentType || 'application/octet-stream');
    const originalName = String(body.originalName || 'recording.webm');
    const audio = await readChunks(chunks, contentType);
    const transcript = await transcribe(audio, originalName);
    const analysis = await analyze({
      kind,
      subjectName: String(body.subjectName || '').trim(),
      staffName: String(body.staffName || '').trim(),
      note: String(body.note || '').trim(),
      transcript,
    });

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const finalAudio = await put(`rm-record/audio/${createdAt.slice(0, 10)}/${id}${safeExtension(originalName, contentType)}`, audio, {
      access: 'private', addRandomSuffix: false, contentType,
    });

    const record = {
      id, createdAt, kind,
      subjectName: String(body.subjectName || '').trim(),
      staffName: String(body.staffName || '').trim(),
      note: String(body.note || '').trim(),
      consentConfirmed: true,
      audio: { url: finalAudio.url, pathname: finalAudio.pathname, originalName, contentType, size: audio.size },
      transcript,
      analysis,
    };

    await put(`rm-record/records/${createdAt.slice(0, 10)}/${id}.json`, JSON.stringify(record), {
      access: 'private', addRandomSuffix: false, contentType: 'application/json; charset=utf-8',
    });
    return res.status(200).json({ record });
  } catch (error) {
    console.error('RM Record processing failed:', error);
    return res.status(500).json({ error: error.message || '처리에 실패했습니다.' });
  } finally {
    await cleanup(chunks);
  }
}
