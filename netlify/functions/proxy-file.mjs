const FILE_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://bakan7.netlify.app';

function corsHeaders(extra = {}) {
  return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET,OPTIONS', ...extra };
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  const url = new URL(request.url);
  const fileId = (url.searchParams.get('fileId') || '').trim();

  if (!FILE_ID_RE.test(fileId)) {
    return new Response(JSON.stringify({ error: 'Invalid fileId' }), { status: 400, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  const apiKey = process.env.GDRIVE_API_KEY_1 || process.env.GDRIVE_API_KEY_2 || process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers: corsHeaders({ 'Content-Type': 'application/json' }) });

  const dlUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  const res = await fetch(dlUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Drive download ${res.status}` }), { status: res.status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) {
    return new Response(JSON.stringify({ error: 'Drive visszaadott HTML-t (nagy fájl vagy nincs jogosultság)' }), { status: 403, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  return new Response(res.body, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
    }),
  });
};
