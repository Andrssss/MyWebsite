// DISPOSABLE — 2026-09-15. Companion to tmp-ai-tech-audit-background.mjs:
// reads the audit result out of the "tmp-ai-tech-audit" Blob store. Remove
// both once the AI-tech-keyword audit is done.
import { getStore } from "@netlify/blobs";

const TOKEN = "f3a9c2e7b6d1508f4a2c7e9b1d6f0a3c8e5b2d9f7a1c4e6b";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const store = getStore("tmp-ai-tech-audit");
  const result = await store.get("result", { type: "json" }).catch(() => null);
  return new Response(JSON.stringify(result || { status: "not_found" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
