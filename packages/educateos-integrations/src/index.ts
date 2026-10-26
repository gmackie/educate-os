// EducateOS interoperability adapters. Each standard is its own namespace, so adapters added later
// (LTI, Thin Common Cartridge) cannot collide on names such as `parse` or `Config`. What every
// integration shares, its sync run records and health, is exported at the top level.

/** OneRoster 1.2 roster import: CSV and REST sources, preview and diff, identity linking, safe apply and sync runs. */
export * as oneroster from "./oneroster/index.ts";
/** Clever Data API v3.1 roster sync: a complete read and an events delta, imported by the OneRoster pipeline. */
export * as clever from "./clever/index.ts";
/** Google Classroom: district-wide roster sync, course linking and grade sync through domain-wide delegation. */
export * as googleclassroom from "./google-classroom/index.ts";
export * from "./sync-run.ts";
/** The interface every roster source implements, so CSV and REST sources are interchangeable. */
export type { RosterSource } from "./oneroster/sync.ts";
