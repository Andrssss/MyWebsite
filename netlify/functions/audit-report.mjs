// netlify/functions/audit-report.mjs
//
// Where the two weekly AUDIT ROUTINES submit their results, and where the hidden
// /allasfigyelo/audit page reads them. Netlify Blobs (same pattern as
// ai-registry / recovery-logs) — one small JSON doc per routine, no schema
// migration, and it keeps a rolling weekly history.
//
//   POST /audit-report   (bearer)   body: { routine, summary?, findings?, ... }
//        → stores the full report, updates that routine's `latest`, and prepends
//          a brief to its capped index.
//
//   GET  /audit-report                → { coverage:{latest,index}, activation:{latest,index} }
//   GET  /audit-report?routine=X&ts=Y → one archived report by timestamp
//
// GET is open (CORS-pinned to the prod origin) so the hidden admin page can read
// it without embedding a token in the frontend — same as the filters/categories
// read endpoints. Only POST is bearer-gated.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "audit-reports";
const ROUTINES = new Set(["coverage", "activation"]);
const INDEX_CAP = 26; // ~half a year of weekly reports kept per routine

const ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

// Strong consistency: index is a read-modify-write and the admin page must see a
// report the moment a routine finishes posting it.
function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function cors(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ORIGIN,
    ...extra,
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: cors(headers) });
}

function authorized(request) {
  const expected = process.env.AUDIT_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return token === expected;
}

const latestKey = (r) => `${r}/latest.json`;
const indexKey = (r) => `${r}/index.json`;
const reportKey = (r, ts) => `${r}/${ts}.json`;

async function readJson(key) {
  try {
    const v = await store().get(key, { type: "json" });
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

async function handlePost(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const routine = String(payload.routine || "").trim();
  if (!ROUTINES.has(routine)) {
    return json(400, { error: "routine must be one of: " + [...ROUTINES].join(", ") });
  }

  const ts = new Date().toISOString();
  const report = { ...payload, routine, generatedAt: payload.generatedAt || ts, storedAt: ts };

  const s = store();
  await s.setJSON(reportKey(routine, ts), report);
  await s.setJSON(latestKey(routine), report);

  const index = (await readJson(indexKey(routine))) || { entries: [] };
  const brief = {
    ts,
    generatedAt: report.generatedAt,
    summary: report.summary ?? null,
    flagged: Array.isArray(report.findings) ? report.findings.length : undefined,
  };
  index.entries = [brief, ...(Array.isArray(index.entries) ? index.entries : [])].slice(0, INDEX_CAP);
  await s.setJSON(indexKey(routine), index);

  return json(200, { ok: true, routine, ts, indexed: index.entries.length });
}

async function handleGet(request) {
  const url = new URL(request.url);
  const routine = url.searchParams.get("routine");
  const ts = url.searchParams.get("ts");

  if (routine && ROUTINES.has(routine) && ts) {
    const report = await readJson(reportKey(routine, ts));
    if (!report) return json(404, { error: "No such report" });
    return json(200, report);
  }

  const out = {};
  for (const r of ROUTINES) {
    out[r] = {
      latest: await readJson(latestKey(r)),
      index: (await readJson(indexKey(r)))?.entries || [],
    };
  }
  return json(200, out);
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: cors({
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }),
    });
  }
  if (request.method === "GET") return handleGet(request);
  if (request.method === "POST") {
    if (!authorized(request)) return json(401, { error: "Unauthorized" });
    return handlePost(request);
  }
  return json(405, { error: "GET or POST only" });
};
