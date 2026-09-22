// DISPOSABLE — 2026-09-22. Reader for tmp-events-full-restore-background's
// blob result. Delete after use (together with its -background companion).
import { getStore } from "@netlify/blobs";

const TOKEN = "1da79ff50cbbe92c6d8045541555a734a2ecdeda29a7c330";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-events-full-restore-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
