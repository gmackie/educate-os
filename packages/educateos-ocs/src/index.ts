// EducateOS Open Course Specification (roadmap §5.3 and §15.10, PR C06): the OCS course package
// contract, the deterministic module resolver and lockfile, the composer, friendly composition for
// teachers, and the export to curriculum activity installations. The format is specified in
// docs/educateos/rfc/0001-open-course-specification.md. OCS is its own contract: Thin CC, Common
// Cartridge and CASE are import and export adapters, not the same thing.
export * from "./semver.ts";
export * from "./schema.ts";
export * from "./errors.ts";
export * from "./package.ts";
export * from "./resolver.ts";
export * from "./library.ts";
export * from "./composer.ts";
export * from "./drafts.ts";
export * from "./export.ts";
export * from "./signatures.ts";
export * from "./thin-cc.ts";
