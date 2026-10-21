// SchoolOS district application (SCHO-95): the merged domain services composed behind one typed
// `/api` surface for the Student, Teacher and Admin UIs (U01-U03). See docs/schoolos/README.md.
export * from "./routes.ts";
export * from "./stores.ts";
export * from "./policy.ts";
export * from "./adapters.ts";
export { CORRELATION_HEADER } from "./http.ts";
export * from "./app.ts";
