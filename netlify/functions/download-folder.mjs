import JSZip from 'jszip';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;
const MAX_FILES = 500;
const MAX_BYTES = 500 * 1024 * 1024;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://bakan7.netlify.app';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    ...extra,
  };
}

function jsonErr(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' }),
  });
}

async function listLevel(folderId, apiKey) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size)',
    pageSize: '200',
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive list ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function collectFiles(folderId, pathPrefix, apiKey) {
  const files = await listLevel(folderId, apiKey);
  const result = [];
  for (const file of files) {
    const filePath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
    if (file.mimeType === FOLDER_MIME) {
      const sub = await collectFiles(file.id, filePath, apiKey);
      result.push(...sub);
    } else if (!file.mimeType.startsWith('application/vnd.google-apps.')) {
      result.push({ ...file, path: filePath });
    }
  }
  return result;
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const folderId = (url.searchParams.get('folderId') || '').trim();
  const zipName = (url.searchParams.get('name') || 'download')
    .replace(/[^\w\s\-.()]/g, '_').trim() || 'download';

  if (!FOLDER_ID_RE.test(folderId)) return jsonErr(400, 'Invalid folderId');

  const apiKey = process.env.GDRIVE_API_KEY_1 || process.env.GDRIVE_API_KEY_2 || process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return jsonErr(500, 'API key not configured');

  try {
    const files = await collectFiles(folderId, '', apiKey);

    if (files.length === 0) return jsonErr(404, 'Nincs letölthető fájl a mappában.');
    if (files.length > MAX_FILES) return jsonErr(413, `Túl sok fájl (${files.length}). Max ${MAX_FILES}.`);

    const totalSize = files.reduce((sum, f) => sum + (parseInt(f.size) || 0), 0);
    if (totalSize > MAX_BYTES) {
      return jsonErr(413, `A mappa túl nagy (${Math.round(totalSize / 1024 / 1024)} MB). Töltsd le Drive-ból!`);
    }

    const zip = new JSZip();
    let added = 0;
    let firstError = null;

    const CONCURRENCY = 5;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (file) => {
        try {
          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&key=${apiKey}`
          );
          if (!res.ok) {
            const body = await res.text();
            const msg = `${file.name}: HTTP ${res.status} – ${body.slice(0, 300)}`;
            console.warn(`[download-folder] skip ${msg}`);
            if (!firstError) firstError = msg;
            return;
          }
          const buf = await res.arrayBuffer();
          zip.file(file.path, buf);
          added++;
        } catch (e) {
          if (!firstError) firstError = `${file.name}: ${e.message}`;
          console.warn(`[download-folder] skip ${file.name}: ${e.message}`);
        }
      }));
    }

    if (added === 0) return jsonErr(500, `Egy fájlt sem sikerült letölteni. Első hiba: ${firstError || 'ismeretlen'}`);

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    return new Response(zipBuffer, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}.zip"`,
        'Cache-Control': 'no-store',
      }),
    });
  } catch (err) {
    console.error('[download-folder]', err.message);
    return jsonErr(500, err.message || 'Ismeretlen hiba');
  }
};
