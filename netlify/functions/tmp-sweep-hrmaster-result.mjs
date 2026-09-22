// DISPOSABLE — 2026-09-22. Reader for tmp-sweep-hrmaster-background's blob
// result. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "fe87167c4f419fd964148b083e8d3b81183d3457df747bd4";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-sweep-hrmaster-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
