import { runBackup } from "./_backup-core.js";

// Weekly schedule – every Monday 01:00 UTC
export const config = {
  schedule: "0 1 * * 1",
};

function budapestDateStamp() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export default async () => {
  try {
    const date = budapestDateStamp();
    const key = await runBackup(`reviews-${date}.json`);
    return new Response(`Weekly backup OK: ${key}`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("Weekly backup failed", { status: 500 });
  }
};
