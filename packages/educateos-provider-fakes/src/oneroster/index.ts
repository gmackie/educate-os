// A OneRoster 1.2 rostering REST fake (ClassLink OAuth 2.0 profile), per the 1EdTech OneRoster 1.2
// Rostering REST/JSON Binding. Start with `OneRosterFake`. The query and projection helpers stay
// internal; only names prefixed for OneRoster are exported, so the barrel merges with the others.
export * from "./fake.ts";
export { ONEROSTER_COLLECTIONS, ROSTERING_PATH as ONEROSTER_ROSTERING_PATH, projectSeed as projectOneRosterSeed } from "./records.ts";
export type { OneRosterCollection, OneRosterRecord } from "./records.ts";
