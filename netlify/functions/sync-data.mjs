// netlify/functions/sync-data.mjs
// Device sync via visitorId. Stores JobWatcher localStorage data in Netlify Blobs.
//
// POST /.netlify/functions/sync-data
//   body: { visitorId, data: { clicked: [...], applied: [...], appliedCache: {...} } }
//
// GET /.netlify/functions/sync-data?visitorId=xxx
//   response: { data: {...} } | { data: null } if not found

import { getStore } from "@netlify/blobs";

const STORE_NAME = "device-sync";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://bakan7.netlify.app";

const MAX_BODY_BYTES = 512 * 1024; // 512 KB / user
const MAX_VISITOR_ID_LEN = 128;
const VISITOR_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const hits = globalThis.__syncDataHits || new Map();
globalThis.__syncDataHits = hits;

function corsHeaders(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(extra),
  });
}

function checkRateLimit(visitorId) {
  const now = Date.now();
  const minTs = now - RATE_LIMIT_WINDOW_MS;
  const ts = (hits.get(visitorId) || []).filter((t) => t > minTs);
  ts.push(now);
  hits.set(visitorId, ts);
  if (hits.size > 3000) {
    for (const [id, list] of hits.entries()) {
      const fresh = list.filter((t) => t > minTs);
      if (fresh.length === 0) hits.delete(id);
      else hits.set(id, fresh);
    }
  }
  return ts.length > RATE_LIMIT_MAX
    ? Math.max(1, Math.ceil((ts[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
    : 0;
}

function validateVisitorId(id) {
  if (!id || typeof id !== "string") return "visitorId is required";
  if (id.length > MAX_VISITOR_ID_LEN) return "visitorId too long";
  if (!VISITOR_ID_RE.test(id)) return "visitorId has invalid format";
  return null;
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }

  const store = getStore(STORE_NAME);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const visitorId = (url.searchParams.get("visitorId") || "").trim();
    const err = validateVisitorId(visitorId);
    if (err) return json(400, { error: err });

    const retryAfter = checkRateLimit(visitorId);
    if (retryAfter > 0) {
      return json(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
    }

    try {
      const data = await store.get(visitorId, { type: "json" });
      return json(200, { data: data || null });
    } catch (e) {
      console.error("[sync-data] GET error:", e);
      return json(500, { error: "Server error" });
    }
  }

  if (request.method === "POST") {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return json(413, { error: "Payload too large" });
    }
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const visitorId = String(payload.visitorId || "").trim();
    const err = validateVisitorId(visitorId);
    if (err) return json(400, { error: err });

    const retryAfter = checkRateLimit(visitorId);
    if (retryAfter > 0) {
      return json(429, { error: "Too many requests" }, { "Retry-After": String(retryAfter) });
    }

    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return json(400, { error: "data object required" });
    }
    const clicked = Array.isArray(data.clicked)
      ? data.clicked.filter((x) => typeof x === "string").slice(0, 2000)
      : [];
    const applied = Array.isArray(data.applied)
      ? data.applied.filter((x) => typeof x === "string").slice(0, 2000)
      : [];
    const appliedCache =
      data.appliedCache && typeof data.appliedCache === "object" && !Array.isArray(data.appliedCache)
        ? data.appliedCache
        : {};

    const sanitized = {
      clicked,
      applied,
      appliedCache,
      updatedAt: new Date().toISOString(),
    };

    try {
      await store.setJSON(visitorId, sanitized);
      return json(200, {
        ok: true,
        counts: { clicked: clicked.length, applied: applied.length },
      });
    } catch (e) {
      console.error("[sync-data] POST error:", e);
      return json(500, { error: "Server error" });
    }
  }

  return json(405, { error: "Method not allowed" });
};
