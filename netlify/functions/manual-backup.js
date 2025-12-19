import { runBackup } from "./_backup-core.js";

function budapestDateStamp() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

export default async () => {
  try {
    const date = budapestDateStamp();
    const filename = `reviews-manual-${date}.json`;

    // ✅ store in Netlify Blobs + also get file content back
    const { key, content } = await runBackup(filename, { returnContent: true });

    // ✅ Force browser download to your PC
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Backup-Key": key,
      },
    });
  } catch (err) {
    console.error("Manual backup error:", err);
    return new Response(
      `Manual backup failed: ${err?.message || String(err)}`,
      { status: 500 }
    );
  }
};
