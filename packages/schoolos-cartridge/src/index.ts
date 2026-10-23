// SchoolOS Thin Common Cartridge importer (roadmap §5.3, PR C04). A cartridge contributes links and
// hierarchy, never execution code: web links go to Content Studio quarantine, LTI links become
// never-launchable tool references, and the organization becomes a proposed curriculum outline.
// Threat model boundary 6: packages are untrusted data, read with bounded, DTD-free parsers.
export * from "./errors.ts";
export * from "./zip.ts";
export * from "./xml.ts";
export * from "./manifest.ts";
export * from "./package.ts";
export * from "./plan.ts";
export * from "./record.ts";
export * from "./importer.ts";
export * from "./tools.ts";
export * from "./suggestions.ts";
export * from "./course.ts";
