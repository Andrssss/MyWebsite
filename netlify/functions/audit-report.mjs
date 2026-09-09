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
//
// A POST whose `findings` array is non-empty also files a GitHub issue on this
// repo (one issue per submitted report, not deduped/merged across the week —
// simplest thing that works since routines already submit at most a couple of
// times a run). Gated on its own GITHUB_ISSUE_TOKEN — deliberately a narrow
// fine-grained PAT scoped to Issues:write on just this repo, not a fallback to
// AUDIT_TOKEN/CRON_SECRET (same narrow-token reasoning as AI_INGEST_TOKEN /
// MARKETING_AI_INGEST_TOKEN elsewhere in this codebase). Fail-soft: a missing
// token or a failed GitHub call never fails the report submission itself, it's
// only surfaced back in the response's `githubIssue` field.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "audit-reports";
const ROUTINES = new Set(["coverage", "activation"]);
const INDEX_CAP = 26; // ~half a year of weekly reports kept per routine

const ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";
const GITHUB_REPO = "Andrssss/MyWebsite";

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

function renderFinding(f, i) {
  const lines = [`### ${i + 1}. ${f.source ?? f.url ?? "(no source)"}`];
  for (const [key, value] of Object.entries(f)) {
    if (key === "source" || value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`**${key}:**\n${value.map((v) => `- ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}`);
    } else if (typeof value === "object") {
      lines.push(`**${key}:** ${JSON.stringify(value)}`);
    } else {
      lines.push(`**${key}:** ${value}`);
    }
  }
  return lines.join("\n\n");
}

async function fileGithubIssue(report) {
  const token = process.env.GITHUB_ISSUE_TOKEN;
  if (!token) return { created: false, reason: "GITHUB_ISSUE_TOKEN not set" };

  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (findings.length === 0) return { created: false, reason: "no findings" };

  const label = report.routine === "coverage" ? "Coverage audit" : "Activation audit";
  const date = String(report.generatedAt || report.storedAt || "").slice(0, 10);
  const sources = [...new Set(findings.map((f) => f.source).filter(Boolean))];
  const sourceList = sources.slice(0, 5).join(", ") + (sources.length > 5 ? ", …" : "");
  const title = `⚡ ${label} ${date}: ${findings.length} finding${findings.length === 1 ? "" : "s"}${sourceList ? ` (${sourceList})` : ""}`.slice(0, 250);

  const body = [
    report.summary ? `**Summary:** ${report.summary}` : null,
    ...findings.map(renderFinding),
    "---",
    "_Filed automatically by the weekly Állásfigyelő audit routine (see `audit-report.mjs`)._",
  ]
    .filter(Boolean)
    .join("\n\n");

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body,
        labels: [report.routine === "coverage" ? "coverage-audit" : "activation-audit"],
      }),
    });
  } catch (e) {
    return { created: false, reason: `fetch failed: ${e.message}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { created: false, reason: `GitHub API ${res.status}: ${text.slice(0, 300)}` };
  }
  const issue = await res.json();
  return { created: true, number: issue.number, url: issue.html_url };
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

  const githubIssue = await fileGithubIssue(report).catch((e) => ({ created: false, reason: String(e) }));

  return json(200, { ok: true, routine, ts, indexed: index.entries.length, githubIssue });
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
