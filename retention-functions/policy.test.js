const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expiresAt, latestActivity } = require("./policy");
test("three calendar months in Taiwan, including month ends", () => {
 for (const [a,b] of [
 ["2026-09-14T12:00:00+08:00","2026-12-14T12:00:00+08:00"],
 ["2026-11-30T23:00:00+08:00","2027-02-28T23:00:00+08:00"],
 ["2027-11-30T23:00:00+08:00","2028-02-29T23:00:00+08:00"]]) assert.equal(expiresAt(Date.parse(a)),Date.parse(b));
});
test("recent activity or migration grace period postpones deletion", () => {
 const stamp=n=>({toMillis:()=>n});
 assert.equal(latestActivity({createdAt:stamp(1),lastOpenedAt:stamp(3),retentionStartedAt:stamp(2)}),3);
 assert.equal(latestActivity({createdAt:stamp(1),retentionStartedAt:stamp(4)}),4);
});
