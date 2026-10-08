import { describe, expect, it } from "vite-plus/test";

import { describeCron } from "./cronDescription.ts";

describe("describeCron", () => {
  it.each([
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["30 18 * * 5,7", "Every Sun and Fri at 18:30"],
    ["0 10 * * sat,sun", "Weekends at 10:00"],
    ["0 2,3,4 * * *", "Daily at 02:00, 03:00 and 04:00"],
    ["0 19,20 * * *", "Daily at 19:00 and 20:00"],
    ["0 3,7,11,15,19,23 * * *", "Daily at 03:00, 07:00, 11:00, 15:00, 19:00 and 23:00"],
    ["15,45 2-19 * * *", "Every hour at :15 and :45, from 02:15 to 19:45"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["*/10 9-17 * * 1-5", "Weekdays, every 10 minutes, from 09:00 to 17:50"],
    ["* * * * *", "Every minute"],
    ["0 * * * *", "Every hour at :00"],
    ["0 */6 * * *", "Daily at 00:00, 06:00, 12:00 and 18:00"],
    ["30 */2 * * *", "Every 2 hours at :30"],
    ["0 9 1 * *", "On the 1st of every month at 09:00"],
    ["0 9 1,15 jan,jul *", "On the 1st and 15th of Jan and Jul at 09:00"],
    ["0 9 * 12 *", "Daily in Dec at 09:00"],
    ["0 9 13 * 5", "On the 13th or every Fri at 09:00"],
  ])("reads %s as %s", (expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  it("returns null for what it cannot read", () => {
    expect(describeCron("0 9 * *")).toBeNull();
    expect(describeCron("61 9 * * *")).toBeNull();
    expect(describeCron("0 9 L * *")).toBeNull();
    expect(describeCron("0 9 * * MON#2")).toBeNull();
  });
});
