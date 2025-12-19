import { runBackup } from "./_backup-core.js";

// Napi ütemezés (egyszer naponta, Cloudflare/cron: UTC szerint fut)
export const config = {
  schedule: "@daily",
};

// Budapest-idő szerinti YYYY-MM-DD (így a fájlnév “helyi nap” alapján készül)
function budapestDateStamp() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // pl. "2025-12-19"
}

export default async () => {
  try {
    const date = budapestDateStamp();
    const key = await runBackup(`reviews-${date}.json`);
    return new Response(`Daily backup OK: ${key}`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("Daily backup failed", { status: 500 });
  }
};
