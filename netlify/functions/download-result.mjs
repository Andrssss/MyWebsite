import { getStore } from '@netlify/blobs';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://bakan7.netlify.app';

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    ...extra,
  };
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: cors() });
  }

  const url = new URL(request.url);
  const jobId = (url.searchParams.get('jobId') || '').trim();

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Missing jobId' }), {
      status: 400, headers: cors({ 'Content-Type': 'application/json' }),
    });
  }

  const store = getStore('zip-jobs');

  const statusEntry = await store.get(jobId, { type: 'json' }).catch(() => null);
  if (!statusEntry) {
    return new Response(JSON.stringify({ status: 'not_found' }), {
      status: 404, headers: cors({ 'Content-Type': 'application/json' }),
    });
  }

  if (statusEntry.status !== 'done') {
    return new Response(JSON.stringify(statusEntry), {
      status: 200, headers: cors({ 'Content-Type': 'application/json' }),
    });
  }

  // Done — return the zip
  const zipData = await store.getWithMetadata(`${jobId}-file`, { type: 'arrayBuffer' }).catch(() => null);
  if (!zipData) {
    return new Response(JSON.stringify({ status: 'error', error: 'Fájl nem található.' }), {
      status: 404, headers: cors({ 'Content-Type': 'application/json' }),
    });
  }

  const zipName = zipData.metadata?.name || 'download';

  // Cleanup
  Promise.all([store.delete(jobId), store.delete(`${jobId}-file`)]).catch(() => {});

  return new Response(zipData.data, {
    status: 200,
    headers: cors({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}.zip"`,
      'Cache-Control': 'no-store',
    }),
  });
};
