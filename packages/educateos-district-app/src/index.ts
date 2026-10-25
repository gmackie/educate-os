// EducateOS district application (SCHO-95): the merged domain services composed behind one typed
// `/api` surface for the Student, Teacher and Admin UIs (U01-U03). See docs/educateos/README.md.
export * from "./routes.ts";
export * from "./stores.ts";
export * from "./policy.ts";
export * from "./adapters.ts";
export { CORRELATION_HEADER } from "./http.ts";
export * from "./app.ts";
export * from "./authority.ts";
export * from "./guard-directory.ts";
export * from "./guardians.ts";
// Communication (SCHO-189)
export * from "./communication/index.ts";
