// DISPOSABLE report reader for tmp-eightfold-fix-background.mjs. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "9f2c7a41e6b830d5f174c2a90b6e83d1a5c7e02f9b41d637";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const report = await getStore({ name: "tmp-ai-audit", consistency: "strong" }).get("eightfold-report.json", { type: "json" });
  return new Response(JSON.stringify(report ?? { status: "not-ready" }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
