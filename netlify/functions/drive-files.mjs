// netlify/functions/drive-files.mjs
// GET /.netlify/functions/drive-files?folderId=FOLDER_ID
// Lists files in a public Google Drive folder using an API key.
// Env: GOOGLE_DRIVE_API_KEY

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://bakan7.netlify.app';
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;

function corsHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(extra) });
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const folderId = (url.searchParams.get('folderId') || '').trim();

  if (!FOLDER_ID_RE.test(folderId)) {
    return json(400, { error: 'Invalid folderId' });
  }

  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return json(500, { error: 'API key not configured' });

  try {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size)',
      orderBy: 'name',
      pageSize: '200',
      key: apiKey,
    });

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!res.ok) {
      const err = await res.json();
      console.error('[drive-files]', err);
      return json(res.status, { error: err.error?.message || 'Drive API error' });
    }

    const data = await res.json();
    return json(200, { files: data.files || [] }, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    console.error('[drive-files]', err.message);
    return json(500, { error: 'Failed to list files' });
  }
};
