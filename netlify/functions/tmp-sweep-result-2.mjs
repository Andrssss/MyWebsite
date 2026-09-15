// DISPOSABLE — 2026-09-15. Reads back tmp-sweep-ai-ats-2-background.mjs's result. Delete alongside it.
import { getStore } from "@netlify/blobs";

const TOKEN = "d4c8f1a02e9b736051f4c8a9e2d61b7f038a5c9e";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-sweep-result-2");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not finished yet" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
