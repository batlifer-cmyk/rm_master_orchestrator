import { del, list } from '@vercel/blob';
import { parseJsonBody, requirePost, requireRmRecordAuth } from '../lib/rm-record-auth.js';

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

function blobConfigured() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireRmRecordAuth(req, res)) return;
  if (!blobConfigured()) return res.status(200).json({ deleted: 0 });

  const body = parseJsonBody(req);
  const uploadId = String(body.uploadId || '');
  if (!UPLOAD_ID_RE.test(uploadId)) {
    return res.status(400).json({ error: '잘못된 업로드 정보입니다.' });
  }

  try {
    const found = await list({ prefix: `rm-record/tmp/${uploadId}/`, limit: 1000 });
    if (found.blobs.length) await del(found.blobs.map((blob) => blob.url));
    return res.status(200).json({ deleted: found.blobs.length });
  } catch (error) {
    console.error('RM Record cleanup failed:', error);
    return res.status(500).json({ error: error.message || '임시 파일 삭제에 실패했습니다.' });
  }
}
