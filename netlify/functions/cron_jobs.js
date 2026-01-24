
const INGEST_URL = "https://bakan7.netlify.app/.netlify/functions/jobs_ingest";
// ha helyben akarod, lehet relatív is, de cronban jobb fix:
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? ""; // Edge env

const SOURCES = [
  { source: "melodiak", url: "https://melodiak.hu/" },   // TODO: konkrét lista URL
  { source: "minddiak", url: "https://minddiak.hu/" },   // TODO
  { source: "muisz",    url: "https://muisz.hu/" },      // TODO
];

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

// nagyon egyszerű “parser”: DOMParser + a linkek szűrése
function extractLinks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];

  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const items = [];

  for (const a of anchors) {
    const title = (a.textContent || "").replace(/\s+/g, " ").trim();
    const href = a.getAttribute("href");
    if (!title || !href) continue;

    const url = absolutize(href, baseUrl);
    if (!url) continue;

    // TODO: SZŰRÉS – ide írd be a mintát, hogy csak állás linkek legyenek
    // pl: if (!url.includes("/allas") && !url.includes("gyakornok")) continue;

    items.push({ title: title.slice(0, 300), url, description: null });
  }

  // dedupe url
  const seen = new Set();
  return items.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
}

export default async () => {
  try {
    let all = [];

    for (const s of SOURCES) {
      const r = await fetch(s.url, { headers: { "User-Agent": "JobWatcher/1.0" } });
      const html = await r.text();

      const items = extractLinks(html, s.url).map((it) => ({
        ...it,
        source: s.source,
      }));

      all = all.concat(items);
    }

    // Küldés a Node ingest functionnek (DB upsert)
    const resp = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INGEST_SECRET ? { "x-ingest-secret": INGEST_SECRET } : {}),
      },
      body: JSON.stringify({ items: all }),
    });

    const txt = await resp.text();
    if (!resp.ok) {
      console.error("Ingest failed:", txt);
      return new Response("Cron ingest failed", { status: 500 });
    }

    return new Response(`Cron OK. Sent ${all.length}. Ingest: ${txt}`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("Cron failed", { status: 500 });
  }
};
