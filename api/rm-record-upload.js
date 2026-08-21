import { put } from '@vercel/blob';
import { parseJsonBody, requirePost, requireRmRecordAuth } from '../lib/rm-record-auth.js';

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export default async function handler(req, res) {
  if (!requirePost(req, res) || !requireRmRecordAuth(req, res)) return;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'Private Blob 스토리지가 아직 연결되지 않았습니다.' });
  }

  const body = parseJsonBody(req);
  const uploadId = String(body.uploadId || '');
  const index = Number(body.index);
  const data = typeof body.data === 'string' ? body.data : '';

  if (!UPLOAD_ID_RE.test(uploadId) || !Number.isInteger(index) || index < 0 || index > 999 || !data) {
    return res.status(400).json({ error: '잘못된 업로드 정보입니다.' });
  }

  try {
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES) {
      return res.status(413).json({ error: '업로드 조각은 최대 2MB입니다.' });
    }

    const blob = await put(
      `rm-record/tmp/${uploadId}/${String(index).padStart(4, '0')}.part`,
      bytes,
      {
        access: 'private',
        addRandomSuffix: false,
        contentType: 'application/octet-stream',
      },
    );

    return res.status(200).json({
      chunk: { url: blob.url, pathname: blob.pathname, index, size: bytes.length },
    });
  } catch (error) {
    console.error('RM Record chunk upload failed:', error);
    return res.status(500).json({ error: error.message || '업로드에 실패했습니다.' });
  }
}
