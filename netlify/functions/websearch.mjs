/*
  Google keresés a felderítő rutinnak (2026-09-01).

  ── Miért egy saját endpoint, és nem curl a promptból ────────────────────
  A rutin beépített WebSearch eszközének a szolgáltatója nem választható meg,
  a google.com/search nyers lekérése pedig 302-vel consent/sorry oldalra megy
  (élő mérés 2026-09-01; a DuckDuckGo lite/html végpontjai ugyanígy
  `anomaly`/`challenge` oldalt adnak).  Marad a hivatalos Google Custom Search
  JSON API — annak viszont kulcsa van, és két okból NEM a routine promptjába
  való:

   • A prompt a routine tárolt szövege: ott a kulcs cserélése az 53 ezer
     karakteres prompt teljes újraírását jelentené, minden rotációnál.
   • Ugyanaz a szabály, mint mindenhol máshol ebben a repóban: a titkok a
     Netlify env-ben laknak, nem a forrásban és nem egy prompt szövegében.

  Így a rutin egyetlen sort hív, a meglévő AI_INGEST_TOKEN-jével — ugyanazzal
  a szűk hatókörű tokennel, amit az ai-ingest / ai-registry / ai-mcp is használ,
  szándékosan NEM az ADMIN_SECRET-tel.

  ── Beállítás ────────────────────────────────────────────────────────────
  Két env-változó a Netlify dashboardon:
    GOOGLE_CSE_KEY  — console.cloud.google.com → Custom Search API engedélyezés
                      → Credentials → API key
    GOOGLE_CSE_CX   — programmablesearchengine.google.com → új engine →
                      "Search the entire web" BE → Search engine ID
  Amíg bármelyik hiányzik, az endpoint 503-at ad egy egyértelmű üzenettel, a
  hívónak pedig vissza kell esnie a saját WebSearch eszközére — ez azért 503 és
  nem 500, hogy a "nincs beállítva" megkülönböztethető legyen a "elromlott"-tól.

  ── Kvóta ────────────────────────────────────────────────────────────────
  Az ingyenes szint napi 100 lekérés (utána a Google 429-et ad, amit
  változatlanul továbbadunk).  Egy hívás legfeljebb 10 találat; a `start`
  paraméterrel lehet lapozni, de minden lap külön lekérés a kvótából.
*/

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const TIMEOUT_MS = 20000;
const MAX_NUM = 10;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (request) => {
  // Ugyanaz a token-pár, mint az AI-család többi végpontján.
  const expected = process.env.AI_INGEST_TOKEN || process.env.CRON_SECRET;
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || token !== expected) return json(401, { error: "Unauthorized" });
  if (request.method !== "GET") return json(405, { error: "GET only" });

  // .trim(): egy dashboardon beillesztett érték végén könnyen marad szóköz vagy
  // sortörés, és a Google arra egy teljesen félrevezető hibaüzenettel válaszol.
  const key = (process.env.GOOGLE_CSE_KEY || "").trim();
  const cx = (process.env.GOOGLE_CSE_CX || "").trim();
  if (!key || !cx) {
    return json(503, {
      error: "search_not_configured",
      missing: [!key && "GOOGLE_CSE_KEY", !cx && "GOOGLE_CSE_CX"].filter(Boolean),
      hint: "Nincs beállítva a Google Custom Search. Használd helyette a saját WebSearch eszközödet.",
    });
  }

  const params = new URL(request.url).searchParams;
  const q = (params.get("q") || "").trim();
  if (!q) return json(400, { error: "q kötelező" });

  const num = Math.min(MAX_NUM, Math.max(1, Number(params.get("num")) || MAX_NUM));
  // A Google `start`-ja 1-alapú, és a 91. találat fölé nem enged.
  const start = Math.min(91, Math.max(1, Number(params.get("start")) || 1));

  const url = new URL(ENDPOINT);
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("num", String(num));
  url.searchParams.set("start", String(start));
  // Opcionális átengedett szűrők — a rutinnak a friss hirdetések számítanak,
  // a magyar nyelvi/ország-preferencia pedig érdemben javítja a találatokat.
  for (const p of ["dateRestrict", "lr", "gl", "siteSearch", "siteSearchFilter"]) {
    const v = params.get(p);
    if (v) url.searchParams.set(p, v);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(url, { signal: ctrl.signal });
    body = await res.json().catch(() => null);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === "AbortError";
    return json(aborted ? 504 : 502, {
      error: aborted ? "search_timeout" : "search_unreachable",
      details: err.message,
    });
  }
  clearTimeout(timer);

  if (!res.ok) {
    // A Google 403-a NEM futásidejű hiba, hanem KONFIGURÁCIÓ: a kulcs projektjében
    // nincs engedélyezve a Custom Search API, vagy a kulcs API-korlátozása másra
    // szól ("This project does not have the access to Custom Search JSON API",
    // élő eset 2026-09-01). A hívónak ez ugyanaz a helyzet, mint a hiányzó env:
    // a kereső most nem használható, essen vissza a saját eszközére. Ezért
    // ugyanazt a 503 `search_not_configured` alakot kapja — a `details` megőrzi
    // a Google eredeti üzenetét, hogy a valódi ok ne vesszen el.
    if (res.status === 403) {
      return json(503, {
        error: "search_not_configured",
        status: 403,
        details: body?.error?.message || null,
        hint: "A Google elutasította a kulcsot (nincs engedélyezve a Custom Search API, vagy rossz az API-korlátozás). Használd helyette a saját WebSearch eszközödet.",
      });
    }
    // A kvóta-kimerülést (429) és minden más Google-hibát változatlan
    // státusszal adunk vissza, hogy a hívó meg tudja különböztetni őket.
    return json(res.status, {
      error: "search_failed",
      status: res.status,
      details: body?.error?.message || null,
      hint: res.status === 429 ? "A napi 100 lekérés elfogyott. Használd a saját WebSearch eszközödet." : undefined,
    });
  }

  const items = Array.isArray(body?.items) ? body.items : [];
  const totalResults = Number(body?.searchInformation?.totalResults || 0);
  return json(200, {
    query: q,
    start,
    count: items.length,
    totalResults,
    // A következő lap kezdőindexe, ha van még találat — így a hívónak nem kell
    // a Google lapozási szabályait ismernie.
    nextStart: body?.queries?.nextPage?.[0]?.startIndex || null,
    results: items.map((it) => ({
      title: it.title,
      link: it.link,
      displayLink: it.displayLink,
      snippet: it.snippet,
    })),
  });
};
