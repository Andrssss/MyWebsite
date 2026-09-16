// DISPOSABLE — 2026-09-16. Reads back tmp-langtech-backfill-background.mjs's
// report (a background function can't return a body to its invoker).
// Delete alongside it.
import { getStore } from "@netlify/blobs";

const TOKEN = "556d087dd508de399bd2bb8e5a24f1a78a724d34";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-langtech-backfill-result");
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "latest.json";
  if (url.searchParams.get("list") === "1") {
    const { blobs } = await store.list();
    return new Response(JSON.stringify(blobs.map((b) => b.key), null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const data = await store.get(key, { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not finished yet" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
