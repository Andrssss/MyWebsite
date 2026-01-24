exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      marker: "SCRAPE_JOBS_MINIMAL_2026-01-24_XX1",  // <- ezt látni kell
      node: process.version,
    }),
  };
};
