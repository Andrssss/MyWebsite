// DISPOSABLE — 2026-09-15. Isolates whether a single fetch() to a
// nofluffjobs URL from this runtime actually completes quickly, independent
// of any background-function semantics. Delete after use.
const TOKEN = "b4e7f1a9c2d6083f5b7e1a9c4d8f2b6e0a3c7d15";

export default async (request) => {
  const auth = (request.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });

  const url =
    new URL(request.url).searchParams.get("url") ||
    "https://nofluffjobs.com/hu/job/data-science-consultant-quantumblack-ai-by-mckinsey-mckinsey-company-budapest";

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "JobWatcher/1.0",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    clearTimeout(timer);
    return new Response(
      JSON.stringify({
        ok: true,
        status: res.status,
        ms: Date.now() - start,
        bytes: text.length,
        hasState: text.includes("serverApp-state"),
      }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    clearTimeout(timer);
    return new Response(
      JSON.stringify({ ok: false, ms: Date.now() - start, error: String(err?.message || err), name: err?.name }),
      { headers: { "content-type": "application/json" } }
    );
  }
};
