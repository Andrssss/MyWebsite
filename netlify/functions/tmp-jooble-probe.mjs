/*
  ELDOBHATÓ diagnosztika (2026-09-02) — deploy → egyszer meghívni → TÖRÖLNI.

  Kérdés: a Jooble Cloudflare-fala a KÉRŐ IP-jétől függ-e?  Otthoni IP-ről a
  `jooble.org/api/<kulcs>` POST és a `jooble.org/api/about` is 403 "Just a
  moment"-et ad, tehát onnan egy API-kulcs sem érne semmit.  Ez a végpont
  ugyanazt a három kérést indítja a Netlify-függvények kimenő IP-jéről, hamis
  kulccsal — nem kell hozzá valódi regisztráció.

  Az olvasat:
   • JSON-hiba / 401 / "invalid key" válasz → a hoszt ELÉRHETŐ innen, van
     értelme kulcsot szerezni és lemérni a Jooble tényleges hozamát.
   • "Just a moment" / cf-mitigated → a fal itt is áll, a Jooble mint forrás
     halott, ne menjen rá több idő.

  Saját, egyszer használatos token — szándékosan NEM a CRON_SECRET és nem az
  ADMIN_SECRET: ez a fájl pár percig él, és nem akarjuk, hogy egy eldobható
  diagnosztika bármelyik igazi kulcsot hordozza.
*/

const TOKEN = "probe-9f3ac1b27e5d4488a0c6";

const TARGETS = [
  {
    name: "api-post",
    url: "https://jooble.org/api/testkey123",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: "junior fejlesztő", location: "Budapest" }),
    },
  },
  { name: "api-about", url: "https://jooble.org/api/about", init: { method: "GET" } },
  { name: "hu-listing", url: "https://hu.jooble.org/", init: { method: "GET" } },
];

// A Cloudflare a fejléc-ujjlenyomatra is szűr, ezért ugyanazt a böngésző-szerű
// User-Agentet küldjük, amivel otthonról is próbáltuk — így a két mérés
// különbsége tényleg csak az IP, nem a fejlécek.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async (request) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (token !== TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const out = [];
  for (const t of TARGETS) {
    const started = Date.now();
    try {
      const res = await fetch(t.url, {
        ...t.init,
        headers: { ...(t.init.headers || {}), "User-Agent": UA, "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8" },
        redirect: "manual",
      });
      const text = await res.text();
      out.push({
        name: t.name,
        url: t.url,
        status: res.status,
        ms: Date.now() - started,
        // A CF-challenge felismerhető jelei — ezekből dől el a válasz.
        cloudflare: /just a moment|cf-mitigated|challenge-platform|__cf_chl/i.test(text),
        server: res.headers.get("server"),
        cfRay: res.headers.get("cf-ray"),
        contentType: res.headers.get("content-type"),
        bytes: text.length,
        head: text.slice(0, 300),
      });
    } catch (err) {
      out.push({ name: t.name, url: t.url, error: err.message });
    }
  }

  return new Response(JSON.stringify({ probedAt: new Date().toISOString(), results: out }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
