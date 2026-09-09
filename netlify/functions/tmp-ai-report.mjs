// DISPOSABLE report reader for tmp-ai-audit-background.mjs. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "763f13e6df929c214d0fdd59a54d83098c16151213335d01";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const report = await getStore({ name: "tmp-ai-audit", consistency: "strong" }).get("report.json", { type: "json" });
  return new Response(JSON.stringify(report ?? { status: "not-ready" }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
