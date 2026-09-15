// DISPOSABLE — 2026-09-15. Reader for tmp-sweep-aiscraped-background's blob
// result. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "8e5cd1792cf8c063feaf48c3146e3aa494d7cab693744fb7";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-sweep-aiscraped-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
