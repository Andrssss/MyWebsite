// DISPOSABLE — 2026-09-22. Reader for tmp-sweep-ai-ats-confirm-background's
// blob result. Delete after use.
import { getStore } from "@netlify/blobs";

const TOKEN = "f4cb89f60f5eb6dcd597d947c5d3aa55139278916d9a563e";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
  const store = getStore("tmp-sweep-ai-ats-confirm-result");
  const data = await store.get("latest.json", { type: "json" });
  return new Response(JSON.stringify(data ?? { status: "not started" }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
