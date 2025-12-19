import { runBackup } from "./_backup-core.js";

export default async () => {
  try {
    // runBackup térjen vissza a JSON adattal is
    const { key, data } = await runBackup("reviews-manual.json", {
      returnData: true,
    });

    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="reviews-manual-${new Date()
          .toISOString()
          .slice(0, 19)
          .replace(/:/g, "-")}.json"`,
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
