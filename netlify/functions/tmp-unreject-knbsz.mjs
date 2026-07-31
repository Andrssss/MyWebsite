// TEMPORARY one-off — remove the KNBSZ entry from the AI-discovery registry's
// permanentlyRejected list. It was added earlier today when fragment-anchored
// URLs got collapsed by normalizeUrl(); that's now fixed (fragments are kept),
// so KNBSZ is no longer a real dead end and shouldn't stay blocklisted for
// future routine runs. TIGRA's rejection entry is untouched — that one is a
// genuine dead end (JS-only accordion, no real anchors at all). Delete this
// file after use.
import { getStore } from "@netlify/blobs";

const ONE_OFF_TOKEN = "b6d9e2a5c8f1b4073d6a9c2e5f8b1d4a7c0e3f6b9d2a5c8f";
const STORE_NAME = "ai-scraped-registry";
const KEY = "registry.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== ONE_OFF_TOKEN) return json(401, { error: "Unauthorized" });

  const raw = await store().get(KEY, { type: "json" });
  if (!raw || typeof raw !== "object") return json(500, { error: "registry missing/malformed" });

  const before = Array.isArray(raw.permanentlyRejected) ? raw.permanentlyRejected : [];
  const removed = before.filter((s) => /knbsz/i.test(String(s)));
  const after = before.filter((s) => !/knbsz/i.test(String(s)));

  const updated = { ...raw, permanentlyRejected: after, updatedAt: new Date().toISOString() };
  await store().setJSON(KEY, updated);

  return json(200, { removed, countBefore: before.length, countAfter: after.length });
};
