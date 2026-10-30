import { demoBlueprint, demoDistrict, demoProvider } from "./demo.ts";

const provider = await demoProvider();
const blueprint = await demoBlueprint(provider);
const north = await demoDistrict(blueprint, provider, "synthetic-north");
const south = await demoDistrict(blueprint, provider, "synthetic-south");
const one = await north.runtime.evaluate(north.request);
const retry = await north.runtime.evaluate(north.request);
const two = await south.runtime.evaluate(south.request);
if (one.reportId !== retry.reportId) throw new Error("Retry must be idempotent");
let denied = false;
try {
  await south.runtime.evaluate({ ...south.request, evidence: north.request.evidence, idempotencyKey: "cross-district" });
} catch { denied = true; }
if (!denied) throw new Error("Cross-district read should fail");
console.log(JSON.stringify({
  assessmentDigest: blueprint.assessmentDigest,
  north: one.report,
  south: two.report,
  idempotentRetry: true,
  crossDistrictRead: "denied",
  notice: "Synthetic in-memory demo; suggestion reports, no official grades or deployed districts.",
}, null, 2));
