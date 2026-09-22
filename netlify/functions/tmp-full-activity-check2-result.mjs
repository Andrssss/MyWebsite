// DISPOSABLE — 2026-09-22. Reader for tmp-full-activity-check2-background's
// blob result. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "a3d8c74f2e769fcc759ef583e0069d4c0554b96cc5f56b4a";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-full-activity-check2-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
