export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  return res.status(200).json({
    storeConfigured: Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN),
    oidcStore: Boolean(process.env.BLOB_STORE_ID),
    legacyToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    oidcTokenPresent: Boolean(process.env.VERCEL_OIDC_TOKEN),
  });
}
