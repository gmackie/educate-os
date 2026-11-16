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

export * from "./gadget-assessment.ts";
// Devices (SCHO-261)
export * from "./devices.ts";
export * from "./product-analytics.ts";
// Pairing (SCHO-261)
export * from "./pairing.ts";
// Operations (SCHO-263)
export * from "./ops.ts";
export * from "./ops-analytics.ts";
// Course library (SCHO-331)
export * from "./course-library.ts";
// District export (SCHO-364)
export * from "./district-export.ts";
// IT review (SCHO-376)
export * from "./admin-review.ts";
// From Google Classroom (SCHO-403)
export * from "./classroom-grades.ts";
// Harbor grade return to Classroom (SCHO-428)
export * from "./classroom-course.ts";
