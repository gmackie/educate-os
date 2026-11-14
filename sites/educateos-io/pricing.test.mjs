// educateos.io/pricing shows the figures cost-to-run.mjs computes from public/assets/cost-to-run.json
// (SCHO-362). Run: node --test sites/educateos-io/pricing.test.mjs

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {COST_DATA, costFigures, monthlyCost} from "./cost-to-run.mjs";
import {stamp} from "./stamp.mjs";

const page = readFileSync(new URL("./public/pricing/index.html", import.meta.url), "utf8");
const doc = readFileSync(new URL("../../docs/educateos/cost-to-run.md", import.meta.url), "utf8");

test("the page carries the figures the data file gives (run build.mjs after changing it)", () => {
  assert.equal(stamp(page, "/pricing/"), page);
  const figures = costFigures();
  for (const [, key, shown] of page.matchAll(/\sdata-cost="([^"]+)"[^>]*>([^<]*)</g)) assert.equal(shown, figures.get(key), key);
});

test("the table has a row for every enrollment size, with usage and seats in separate columns", () => {
  for (const size of COST_DATA.sizes) {
    for (const field of ["students", "teachers", "usage", "perStudent", "access"]) {
      assert.match(page, new RegExp(`data-cost="${size}\\.${field}"`), `${size}.${field}`);
    }
  }
});

test("usage is the sum of its lines, and Access seats are not one of them", () => {
  for (const size of COST_DATA.sizes) {
    const cost = monthlyCost(size);
    const lines = Object.values(cost.lines).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(cost.usage - lines) < 1e-9);
    assert.ok(!("total" in cost) && !("access" in cost.lines), "seats stay a separate line");
    assert.equal(cost.lines.base, COST_DATA.prices.workersBase.usd);
  }
});

test("the page shows no total that adds seats to usage, and says why seats are apart", () => {
  assert.doesNotMatch(page, /data-cost="\d+\.total"/);
  assert.match(page, /already (?:have|license|use) Cloudflare Zero Trust/);
  assert.match(page, /SCHO-369/);
});

test("a 500-student district, worked by hand as in cost-to-run.md", () => {
  const cost = monthlyCost(500);
  assert.equal(cost.teachers, 34);
  assert.equal(cost.seats, 500 + 34 + 250);
  // 500*120*20 + 34*400*20 + 250*40 app requests, 34*40*20 in the AI workspace, 749 cron runs.
  assert.equal(cost.quantities.requests, 1_200_000 + 272_000 + 10_000 + 27_200 + 749);
  assert.equal(cost.lines.requests, 0);
  // The district object all month plus 34 teachers' hour a school day, at 128 MB.
  assert.equal(cost.quantities.gbSeconds, 31 * 86_400 * 0.125 + 34 * 3_600 * 20 * 0.125);
  assert.ok(Math.abs(cost.lines.duration - ((cost.quantities.gbSeconds - 400_000) / 1e6) * 12.5) < 1e-9);
  assert.equal(cost.access, 784 * 7);
});

test("50 people or fewer signing in cost nothing in Access seats (Zero Trust Free)", () => {
  assert.equal(monthlyCost(30).access, 0);
});

test("every measured or assumed input is labeled that way on the page", () => {
  for (const [key, entry] of Object.entries(COST_DATA.assumptions)) {
    if (key.startsWith("$") || entry.kind === "published") continue;
    const row = page.split("<tr>").find((r) => r.includes(`data-cost="a.${key}"`));
    assert.ok(row, `the method table shows ${key}`);
    assert.match(row, entry.kind === "measured" ? />Measured</ : />Assumed</, key);
  }
});

test("every price is cited on the page and in the measurement note", () => {
  for (const [key, price] of Object.entries(COST_DATA.prices)) {
    if (key.startsWith("$")) continue;
    assert.ok(page.includes(`href="${price.source}"`), `page cites ${price.source}`);
    assert.ok(doc.includes(price.source), `cost-to-run.md cites ${price.source}`);
  }
});
