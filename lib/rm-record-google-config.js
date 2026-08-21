import { get, list, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';

const CONFIG_PREFIX = 'rm-record/config/google-client-';

function blobConfigured() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export function normalizeGoogleClientId(value) {
  const clientId = String(value || '').trim();
  if (!clientId || clientId.length > 300) return '';
  if (!clientId.endsWith('.apps.googleusercontent.com')) return '';
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) return '';
  return clientId;
}

export async function getRmGoogleClientId() {
  const envClientId = normalizeGoogleClientId(
    process.env.RM_RECORD_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ''
  );
  if (envClientId) return envClientId;
  if (!blobConfigured()) return '';

  const found = await list({ prefix: CONFIG_PREFIX, limit: 100 });
  const blobs = [...found.blobs].sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );

  for (const blob of blobs) {
    try {
      const stored = await get(blob.url, { access: 'private', useCache: false });
      if (!stored || stored.statusCode !== 200 || !stored.stream) continue;
      const parsed = JSON.parse(await new Response(stored.stream).text());
      const clientId = normalizeGoogleClientId(parsed?.clientId);
      if (clientId) return clientId;
    } catch (error) {
      console.error('RM Record Google config read failed:', error);
    }
  }
  return '';
}

export async function saveRmGoogleClientId(value) {
  const clientId = normalizeGoogleClientId(value);
  if (!clientId) throw new Error('올바른 Google Web Client ID가 아닙니다.');
  if (!blobConfigured()) throw new Error('Private Blob 스토리지가 연결되지 않았습니다.');

  await put(`${CONFIG_PREFIX}${Date.now()}-${randomUUID()}.json`, JSON.stringify({
    clientId,
    updatedAt: new Date().toISOString(),
  }), {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/json; charset=utf-8',
  });
  return clientId;
}
