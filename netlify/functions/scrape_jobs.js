exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      ok: true,
      marker: "SCRAPE_JOBS_NEW_NAME",
      node: process.version,
    }),
  };
};
