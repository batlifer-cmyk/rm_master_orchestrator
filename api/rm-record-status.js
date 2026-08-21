export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  return res.status(200).json({
    service: 'rm-record-hosting-check',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  });
}
