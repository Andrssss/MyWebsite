// netlify/functions/_job_events_store.mjs
//
// "job-events" Netlify Blob: upcoming állásbörzék / céges eventek, gyűjtve
// AI-extrakcióval (_ai_events_extract_core.mjs) az `event_sources` táblában
// regisztrált oldalakról. Ugyanaz a minta, mint a "job-stats" blob
// (_daily_stats_store.mjs) — derived, teljesen újraépíthető adat, nincs rá
// relációs hozzáférési minta, egyetlen napi cron írja.
//
// Store: "job-events", egyetlen kulcs "latest.json":
//   { generatedAt, events: [{ url, title, date, endDate, time, endTime,
//                             location, company, type, free,
//                             registrationDeadline, deadlineChecked,
//                             source, firstSeenAt }] }
// `url` a sor identitása (mint job_posts-nál). `date` (és opcionális
// `endDate`) ISO "YYYY-MM-DD". Egy esemény akkor "múltbeli", ha a záró
// (vagy hiányában a kezdő) dátuma korábbi a mai UTC napnál — ilyeneket
// minden futás kitöröl a blobból, ez a "múltban levőket kitörli" garancia.
// `type`/`registrationDeadline`/`deadlineChecked` a
// cron_job_events-background.mjs+_ai_events_extract_core.mjs párosból
// érkeznek (2026-09-08) — ez a modul EGYÉBKÉNT mezőagnosztikus, csak
// áthalad rajtuk, nincs itt külön kezelésük. `deadlineChecked` belső
// bookkeeping — az allasfigyelo /events oldala (a blob egyetlen olvasója)
// nem használja, csak azt jelzi ennek a modulnak, hogy a határidő-follow-up
// már lefutott erre a sorra, ne fizessen rá újra egy örökre üres mezőre.
//
// `free` (2026-09-22, user request: "csak ingyeneseket akarunk") a
// KIVÉTEL a mezőagnosztikusság alól — a purge-höz hasonlóan ez a modul
// aktívan kiszűri a `free === false` sorokat minden íráskor (ld.
// mergeAndPurgeEvents), nem csak áthalad rajtuk. Ez véd a jövőbeli cron-
// futásoktól (fizetős esemény sosem kerül be) ÉS a régi, e mező előtti
// sorok egyszeri visszamenőleges tisztításától is (ld. a diszpozábilis
// tmp-events-*-cleanup endpoint) — mindkettő ugyanezen az egy szűrőn megy
// át, ha a hívó a teljes újra-osztályozott listát adja át `incoming`-ként.
//
// Országos relevancia-szűrő (2026-09-22, pestidev.hu issue #56): a korábbi,
// dokumentálatlan egyszeri feltöltés olyan külföldi fizetős konferenciákat
// is bevitt a blobba, mint a STARWEST (Anaheim, USA) vagy a Targeting
// Quality (Ontario, Kanada) — semmi közük Magyarországhoz/Budapesthez, a
// tábla célja ("Csak Budapest · Csak IT") ezt kizárja. `looksHungaryRelevant`
// ugyanúgy a purge-höz/free-szűrőhöz csatlakozik: `online`/`hybrid` formátum
// mindig átmegy (helyfüggetlen, bárhonnan elérhető), `inperson` csak akkor,
// ha a `location` egy ismert magyar városnevet/"Magyarország"/"Hungary"
// szót tartalmaz; hiányzó `location` megengedően átmegy (nem büntetjük a
// hiányzó adatot — l. a #56 másik pontja, ahol pont egy valós budapesti
// állásbörzének nem volt `location` mezője).

import { getStore } from "@netlify/blobs";

const STORE_NAME = "job-events";
const BLOB_KEY = "latest.json";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function isPast(event, today) {
  const cutoff = event.endDate || event.date;
  return !cutoff || cutoff < today;
}

const HUNGARY_LOCATION_RE =
  /magyarorsz|hungary|budapest|debrecen|szeged|p[eé]cs|gy[oő]r|miskolc|veszpr[eé]m|sz[eé]kesfeh[eé]rv[aá]r|szombathely|sopron|kecsk[eé]m[eé]t|ny[ií]regyh[aá]za|p[aá]pa|paks|eger|kaposv[aá]r|zalaegerszeg|szolnok|tatab[aá]nya|salg[oó]tarj[aá]n|szekszárd|dunaújváros|erd|budaörs/i;

// online/hybrid: location-agnostic, always relevant (see file header). No
// `location` at all: permissive pass, missing data isn't itself a signal of
// being foreign. inperson: only relevant if the venue text names Hungary.
function looksHungaryRelevant(event) {
  if (event.format && event.format !== "inperson") return true;
  if (!event.location) return true;
  return HUNGARY_LOCATION_RE.test(event.location);
}

function sortByDate(events) {
  return [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function readEvents() {
  const raw = await store().get(BLOB_KEY, { type: "json" });
  if (!raw || !Array.isArray(raw.events)) {
    return { generatedAt: null, events: [] };
  }
  return raw;
}

async function writeEvents(events) {
  const payload = {
    generatedAt: new Date().toISOString(),
    events: sortByDate(events),
  };
  await store().setJSON(BLOB_KEY, payload);
  return payload;
}

/**
 * Beolvasztja `incoming` eseményeket a tárolt listába (upsert `url` szerint,
 * megőrizve az eredeti `firstSeenAt`-et), majd eldobja a lejárt, a fizetős
 * (`free === false`) ÉS a nem magyar-releváns (külföldi inperson) sorokat —
 * akkor is, ha `incoming` üres, hogy a takarítás önmagában, forrás nélkül is
 * lefusson minden ütemezett futáskor. Mindhárom szűrő egy meglévő, már
 * tárolt sort is eltávolít újra-osztályozáskor, nem csak az újonnan
 * beérkezőket.
 */
export async function mergeAndPurgeEvents(incoming) {
  const today = todayUTC();
  const { events: current } = await readEvents();

  const byUrl = new Map(current.map((e) => [e.url, e]));
  const now = new Date().toISOString();
  for (const ev of incoming) {
    if (!ev?.url) continue;
    const existing = byUrl.get(ev.url);
    byUrl.set(ev.url, { ...ev, firstSeenAt: existing?.firstSeenAt || now });
  }

  const merged = [...byUrl.values()].filter(
    (e) => !isPast(e, today) && e.free !== false && looksHungaryRelevant(e),
  );
  return writeEvents(merged);
}
