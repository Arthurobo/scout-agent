import { logger, schedules } from "@trigger.dev/sdk";
import { getDb } from "../db/client.js";
import { runRetention } from "../db/retention.js";

export const retention = schedules.task({
  id: "retention",
  cron: { pattern: "0 3 * * *", timezone: "UTC" },
  run: async () => {
    const counts = await runRetention(getDb());
    logger.info("retention finished", counts);
    return counts;
  },
});
