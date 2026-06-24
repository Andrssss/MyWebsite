import JSZip from 'jszip';
import { getStore } from '@netlify/blobs';

export const config = { background: true };

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,100}$/;

async function listLevel(folderId, apiKey) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size)',
    pageSize: '200',
    key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  if (!res.ok) throw new Error(`Drive list HTTP ${res.status}`);
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
  const url = new URL(request.url);
  const folderId = (url.searchParams.get('folderId') || '').trim();
  const jobId    = (url.searchParams.get('jobId') || '').trim();
  const zipName  = (url.searchParams.get('name') || 'download').replace(/[^\w\s\-.()]/g, '_').trim();

  if (!FOLDER_ID_RE.test(folderId) || !jobId) return;

  const apiKey = process.env.GDRIVE_API_KEY_1 || process.env.GDRIVE_API_KEY_2 || process.env.GOOGLE_DRIVE_API_KEY;
  const store = getStore('zip-jobs');

  try {
    await store.setJSON(jobId, { status: 'processing' });

    console.log(`[bg] collecting files for ${folderId}`);
    const files = await collectFiles(folderId, '', apiKey);
    console.log(`[bg] found ${files.length} files`);

    if (files.length === 0) {
      await store.setJSON(jobId, { status: 'error', error: 'Nincs letölthető fájl.' });
      return;
    }

    const zip = new JSZip();
    let added = 0;
    let firstError = null;

    const CONCURRENCY = 8;
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      await Promise.all(files.slice(i, i + CONCURRENCY).map(async (file) => {
        try {
          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&key=${apiKey}`
          );
          if (!res.ok) {
            const body = await res.text();
            const msg = `${file.name}: HTTP ${res.status} – ${body.slice(0, 200)}`;
            console.warn(`[bg] skip ${msg}`);
            if (!firstError) firstError = msg;
            return;
          }
          zip.file(file.path, await res.arrayBuffer());
          added++;
        } catch (e) {
          console.warn(`[bg] skip ${file.name}: ${e.message}`);
          if (!firstError) firstError = e.message;
        }
      }));
    }

    console.log(`[bg] added ${added}/${files.length} files, generating zip`);

    if (added === 0) {
      await store.setJSON(jobId, { status: 'error', error: firstError || 'Minden fájl letöltése sikertelen.' });
      return;
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    console.log(`[bg] zip size: ${zipBuffer.length} bytes`);

    await store.set(`${jobId}-file`, zipBuffer, {
      metadata: { name: zipName, size: String(zipBuffer.length) },
    });
    await store.setJSON(jobId, { status: 'done', name: zipName });
    console.log(`[bg] done, jobId=${jobId}`);
  } catch (err) {
    console.error('[download-background]', err.message);
    try { await store.setJSON(jobId, { status: 'error', error: err.message }); } catch {}
  }
};
