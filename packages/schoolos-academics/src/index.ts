// SchoolOS AcademicDirectory (roadmap A01): the domain service, its storage (in memory and on D1), source-of-record
// enforcement, a placeholder authorizer, and the HTTP and tool surfaces over the same operations.
export * from "./authority.ts";
export * from "./validation.ts";
export * from "./store.ts";
export * from "./d1-store.ts";
export * from "./inputs.ts";
export { AcademicDirectory, isDistrictAdmin, type AcademicDirectoryOptions } from "./directory.ts";
export * from "./sync.ts";
export * from "./role-table-authorizer.ts";
export * from "./operations.ts";
export * from "./http.ts";
export * from "./tools.ts";
