// EducateOS project artifacts on Cloudflare Artifacts (roadmap W03): multi-file notebooks, code and
// datasets saved as Git-backed versions of `@educateos/learning-artifacts` artifacts, with Save,
// History and Diff; short-lived per-principal Git credentials, revoked when a course closes; and
// sanitized, parentless forks of teacher baselines. Where the district's plan has no Artifacts,
// versions fall back to learning-artifacts' own text or R2 storage. See docs/educateos/artifacts-git.md.
export * from "./git-objects.ts";
export * from "./model.ts";
export * from "./globs.ts";
export * from "./artifacts-api.ts";
export * from "./credentials.ts";
export * from "./backend.ts";
export * from "./projects.ts";
export * from "./fake.ts";
