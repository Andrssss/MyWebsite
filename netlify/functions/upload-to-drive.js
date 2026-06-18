const { google } = require('googleapis');
const { Readable } = require('stream');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";
const DRIVE_FOLDER_ID = process.env.DRIVE_UPLOAD_FOLDER_ID;

const MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4MB base64 payload limit

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/zip',
  'image/jpeg',
  'image/png',
]);

const uploadHits = globalThis.__uploadHits || new Map();
globalThis.__uploadHits = uploadHits;

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function getClientIp(event) {
  const h = event.headers || {};
  return (h["x-forwarded-for"] || h["x-nf-client-connection-ip"] || "unknown")
    .split(",")[0].trim();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60 * 1000; // 1 perc
  const max = 5;
  const hits = (uploadHits.get(ip) || []).filter(ts => ts > now - window);
  hits.push(now);
  uploadHits.set(ip, hits);
  return hits.length > max;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const ip = getClientIp(event);
  if (checkRateLimit(ip)) {
    return { statusCode: 429, headers: corsHeaders(), body: JSON.stringify({ error: "Túl sok feltöltés, várj egy percet." }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { fileName, mimeType, base64Data } = body;

  if (!fileName || typeof fileName !== 'string' || fileName.length > 255) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Érvénytelen fájlnév" }) };
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Nem támogatott fájltípus" }) };
  }

  if (!base64Data || typeof base64Data !== 'string') {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "Hiányzó fájladat" }) };
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_SIZE_BYTES) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: "A fájl túl nagy (max 4MB)" }) };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    console.error('[upload-to-drive] Missing or invalid GOOGLE_SERVICE_ACCOUNT_JSON');
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: "Szerver konfiguráció hiba" }) };
  }

  if (!DRIVE_FOLDER_ID) {
    console.error('[upload-to-drive] Missing DRIVE_UPLOAD_FOLDER_ID');
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: "Szerver konfiguráció hiba" }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });
    const stream = Readable.from(buffer);

    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: mimeType,
        body: stream,
      },
    });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ ok: true, fileId: response.data.id }),
    };
  } catch (err) {
    console.error('[upload-to-drive] Drive API error:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Feltöltés sikertelen" }),
    };
  }
};
