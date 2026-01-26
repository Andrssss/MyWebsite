import { runBackup, listBackups, deleteBackup } from "./_backup-core.js";

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
  return fmt.format(new Date()); // YYYY-MM-DD
}

function parseBackupDateFromKey(key) {
  // reviews-YYYY-MM-DD.json
  const m = String(key).match(/^reviews-(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) return null;

  // stabil: UTC középéj + Z
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async () => {
  try {
    // 1) új backup
    const today = budapestDateStamp();
    const keepKey = `reviews-${today}.json`;
    await runBackup(keepKey);

    // 2) cutoff: 10 napnál régebbi törlődjön
    const now = Date.now();
    const cutoffMs = now - 10 * 24 * 60 * 60 * 1000;

    // 3) listázás + törlés
    const backups = await listBackups({ prefix: "reviews-" });

    let deleted = 0;
    for (const b of backups) {
      const key = b.key ?? b; // attól függ, mit ad vissza a listBackups
      if (!key || key === keepKey) continue;

      const d = parseBackupDateFromKey(key);
      if (!d) continue;

      if (d.getTime() < cutoffMs) {
        await deleteBackup(key);
        deleted++;
      }
    }

    return new Response(`Weekly backup OK: ${keepKey} (deleted: ${deleted})`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("Weekly backup failed", { status: 500 });
  }
};
