// SchoolOS interoperability adapters. Each standard is its own namespace, so adapters added later
// (LTI, Thin Common Cartridge) cannot collide on names such as `parse` or `Config`.

/** OneRoster 1.2 CSV import: parsing, preview and diff, identity linking and safe apply. */
export * as oneroster from "./oneroster/index.ts";
