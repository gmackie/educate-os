// SchoolOS signed releases (roadmap R03, threat model T12): the root signs release manifests with
// rotating keys the district pins; the district verifies every offer locally and decides whether
// to approve, decline or defer it; the root rolls releases out in stages and halts on failing
// fleet health.
export * from "./semver.ts";
export * from "./trust.ts";
export * from "./manifest.ts";
export * from "./signer.ts";
export * from "./policy.ts";
export * from "./district.ts";
export * from "./rollout.ts";
