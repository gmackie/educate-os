// EducateOS home learning (ADR-0016): parent-managed K-2 practice for a community installation.
export * from "./model.ts";
export * from "./scoring.ts";
export * from "./progress.ts";
export * from "./secrets.ts";
export * from "./storage.ts";
export * from "./service.ts";
export * from "./relationships.ts";
export {
  PACKS,
  currentPacks,
  currentPackFor,
  resolveActivity,
  itemOf,
  refTo,
  type ResolvedActivity,
  Pack,
  Activity,
  ActivityRef,
  Item,
  Skill,
  Track,
  Strand,
  GradeBand,
  PackId,
  ActivityKey,
  type ItemType,
  type ActivityMode,
} from "./content/index.ts";
