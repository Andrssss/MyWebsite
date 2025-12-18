import { runBackup } from "./_backup-core.js";

export const config = {
  schedule: "@weekly",
};

export default async () => {
  try {
    const key = await runBackup("reviews-latest.json");
    return new Response(`Weekly backup OK: ${key}`, { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("Weekly backup failed", { status: 500 });
  }
};
