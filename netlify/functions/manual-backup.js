import { runBackup } from "./_backup-core.js";

export default async () => {
  try {
    const key = await runBackup("reviews-manual.json");
    return Response.json({
      status: "ok",
      backup: key,
      time: new Date().toISOString(),
    });
    } catch (err) {
    console.error("Manual backup error:", err);
        return new Response(
            `Manual backup failed: ${err?.message || String(err)}`,
            { status: 500 }
        );
    }

};
