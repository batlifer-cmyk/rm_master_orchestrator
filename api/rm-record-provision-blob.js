const ONE_TIME_SECRET = 'J-InLD4Ocn6v-N9dUpscjcsukZvnHRMVktTAhnDcXbQ';
const TEAM_ID = 'team_p0qNKeBIVj25JkFAqHqETto9';
const PROJECT_ID = 'prj_ARy0A1TvjaxKmThZBqbdf0knkUiq';

async function callVercel(path, token, init = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`https://api.vercel.com${path}${separator}teamId=${TEAM_ID}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
  return { ok: response.ok, status: response.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (req.query?.secret !== ONE_TIME_SECRET) {
    return res.status(404).json({ error: 'Not Found' });
  }

  const oidcToken = req.headers['x-vercel-oidc-token'];
  if (!oidcToken || Array.isArray(oidcToken)) {
    return res.status(503).json({
      error: 'Vercel runtime OIDC token is not available.',
      hasOidcHeader: Boolean(oidcToken),
    });
  }

  const create = await callVercel('/v1/storage/stores/blob', oidcToken, {
    method: 'POST',
    body: JSON.stringify({
      name: 'rm-record-private',
      region: 'iad1',
      access: 'private',
    }),
  });

  if (!create.ok) {
    return res.status(create.status).json({
      stage: 'create',
      oidcPresent: true,
      upstreamStatus: create.status,
      upstream: create.data,
    });
  }

  const storeId = create.data?.store?.id;
  if (!storeId) {
    return res.status(502).json({ stage: 'create', error: 'Store created but no store id returned.', upstream: create.data });
  }

  const connect = await callVercel(`/v1/storage/stores/${encodeURIComponent(storeId)}/connections`, oidcToken, {
    method: 'POST',
    body: JSON.stringify({
      envVarEnvironments: ['production', 'preview', 'development'],
      projectId: PROJECT_ID,
      type: 'integration',
    }),
  });

  return res.status(connect.ok ? 200 : 502).json({
    stage: connect.ok ? 'done' : 'connect',
    oidcPresent: true,
    storeId,
    storeCreated: true,
    connected: connect.ok,
    connectStatus: connect.status,
    connectResult: connect.data,
  });
}
