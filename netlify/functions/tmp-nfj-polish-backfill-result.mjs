// DISPOSABLE — 2026-09-15. Reads back tmp-nfj-polish-backfill-background.mjs's
// report (a background function can't return a body to its invoker).
// Delete alongside it.
import { getStore } from "@netlify/blobs";

const TOKEN = "b4e7f1a9c2d6083f5b7e1a9c4d8f2b6e0a3c7d15";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-nfj-polish-backfill-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not finished yet" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
