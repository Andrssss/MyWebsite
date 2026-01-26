import { runBackup, listBackups, deleteBackup } from "./_backup-core.js";

export const config = {
  schedule: "0 1 * * 1", // Monday 01:00 UTC
};

function budapestDateStamp() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // YYYY-MM-DD
}

function parseBackupDateFromKey(key) {
  // reviews-YYYY-MM-DD.json
  const m = String(key).match(/^reviews-(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async () => {
  try {
    // 1) új backup
    const today = budapestDateStamp();
    const keepKey = `reviews-${today}.json`;
    await runBackup(keepKey);

    // 2) cutoff: 10 nap
    const cutoffMs = Date.now() - 10 * 24 * 60 * 60 * 1000;

    // 3) listázás + törlés
    const backups = await listBackups({ prefix: "reviews-" });

    let deleted = 0;

    for (const b of backups) {
      const key = b?.key ?? b?.name ?? b; // defensive
      if (!key || key === keepKey) continue;

      const d = parseBackupDateFromKey(key);
      if (!d) continue;

      if (d.getTime() < cutoffMs) {
        await deleteBackup(key);
        deleted++;
      }
    }

    return new Response(
      `Weekly backup OK: ${keepKey} (deleted: ${deleted})`,
      { status: 200 }
    );
  } catch (err) {
    console.error(err);
    return new Response("Weekly backup failed", { status: 500 });
  }
};
