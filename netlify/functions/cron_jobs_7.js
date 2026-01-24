const main = require("./cron_jobs");
exports.config = { schedule: "0 4 * * *" };
exports.handler = async (event, context) => {
  event.queryStringParameters = { ...(event.queryStringParameters || {}), batch: "7", size: "3" };
  return main.handler(event, context);
};
