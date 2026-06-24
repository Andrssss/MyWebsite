const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://bakan7.netlify.app';

function corsHeaders(extra = {}) {
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET,OPTIONS', ...extra };
}

async function listLevel(folderId, apiKey) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size)',
    pageSize: '200',
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  return (await res.json()).files || [];
}

async function collect(folderId, prefix, apiKey) {
  const items = await listLevel(folderId, apiKey);
  const result = [];
  for (const item of items) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.mimeType === FOLDER_MIME) {
      result.push(...await collect(item.id, path, apiKey));
    } else if (!item.mimeType.startsWith('application/vnd.google-apps.')) {
      result.push({ id: item.id, name: item.name, path, size: item.size });
    }
  }
  return result;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  const url = new URL(request.url);
  const folderId = (url.searchParams.get('folderId') || '').trim();
  if (!FOLDER_ID_RE.test(folderId)) {
    return new Response(JSON.stringify({ error: 'Invalid folderId' }), { status: 400, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  const apiKey = process.env.GDRIVE_API_KEY_1 || process.env.GDRIVE_API_KEY_2 || process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers: corsHeaders({ 'Content-Type': 'application/json' }) });

  try {
    const files = await collect(folderId, '', apiKey);
    return new Response(JSON.stringify({ files }), { status: 200, headers: corsHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }) });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }
};
