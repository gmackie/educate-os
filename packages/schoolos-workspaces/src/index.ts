// SchoolOS workspace directory (roadmap W01): logical personal and course workspaces, provisioned
// lazily per student, with a derived lifecycle, legal hold, term close and rollover preview, and
// promotion links. Every read is decided by the `@schoolos/policy` engine.
export * from "./model.ts";
export * from "./lifecycle.ts";
export * from "./store.ts";
export * from "./directory.ts";
export * from "./workshop-adapter.ts";
export * from "./principal-lifecycle.ts";
