import { get, list } from '@vercel/blob';
import { requirePost, requireRmRecordAuth } from '../lib/rm-record-auth.js';

function blobConfigured() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireRmRecordAuth(req, res)) return;
  if (!blobConfigured()) {
    return res.status(200).json({ records: [], blobConfigured: false });
  }

  try {
    const found = await list({ prefix: 'rm-record/records/', limit: 1000 });
    const blobs = [...found.blobs]
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .slice(0, 20);

    const records = [];
    for (const blob of blobs) {
      try {
        const stored = await get(blob.url, { access: 'private', useCache: false });
        if (!stored || stored.statusCode !== 200 || !stored.stream) continue;
        const record = JSON.parse(await new Response(stored.stream).text());
        records.push({
          id: record.id,
          createdAt: record.createdAt,
          kind: record.kind,
          subjectName: record.subjectName,
          staffName: record.staffName,
          title: record.analysis?.title || '',
          summary: record.analysis?.summary || '',
          duration: Number(record.transcript?.duration || 0),
        });
      } catch (error) {
        console.error('RM Record recent item read failed:', error);
      }
    }

    return res.status(200).json({ records, blobConfigured: true });
  } catch (error) {
    console.error('RM Record recent records failed:', error);
    return res.status(500).json({ error: error.message || '최근 기록 조회에 실패했습니다.' });
  }
}
