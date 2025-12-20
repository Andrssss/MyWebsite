import { runBackup } from "./_backup-core.js";

// Netlify schedules are evaluated in UTC. We'll run hourly and gate by Budapest local time.
// Docs: Scheduled Functions use cron format and run in UTC.
export const config = {
  schedule: "0 * * * *", // every hour, at minute 0 (UTC)
};

function budapestNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`, // YYYY-MM-DD
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

export default async () => {
  try {
    const { date, hour, minute } = budapestNowParts();

    // Only run at 21:00 Budapest time
    if (!(hour === 21 && minute === 0)) {
      return new Response("Not time yet (Budapest 21:00).", { status: 204 });
    }

    // ✅ FIX NÉV: mindig ezt írja felül
    const keyName = "reviews-latest.json";

    const result = await runBackup(keyName);

    // Your runBackup currently returns { key } or key depending on your version.
    const key = typeof result === "string" ? result : result?.key ?? keyName;

    return new Response(`Daily backup OK (Budapest 21:00, ${date}): ${key}`, {
      status: 200,
    });
  } catch (err) {
    console.error(err);
    return new Response(`Daily backup failed: ${err?.message || String(err)}`, {
      status: 500,
    });
  }
};
