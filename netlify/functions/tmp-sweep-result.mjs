// DISPOSABLE — 2026-09-15. Reads back the result of tmp-sweep-ai-ats-background.mjs
// (a background function can't return a body to its invoker). Delete alongside it.
import { getStore } from "@netlify/blobs";

const TOKEN = "11286b20c897f7d8315b26e2de95fe65a211f7ea991cb7c4";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-sweep-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not finished yet" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
