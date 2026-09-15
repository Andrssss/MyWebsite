// DISPOSABLE — 2026-09-15. Reads back tmp-ai-review-background.mjs's report
// (a background function can't return a body to its invoker). Delete alongside it.
import { getStore } from "@netlify/blobs";

const TOKEN = "7a2f9c3e6b1d84075a9e2c6f1b8d3a4e91c65d02";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-ai-review-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not finished yet" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
