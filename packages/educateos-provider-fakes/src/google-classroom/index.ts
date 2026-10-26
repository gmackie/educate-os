// A Google Classroom API v1 fake, per Google's Classroom REST reference. Start with
// `GoogleClassroomFake`. Error helpers are exported under Classroom names so this barrel merges
// with the other fakes'.
export * from "./fake.ts";
export { googleErrorResponse as classroomErrorResponse } from "./errors.ts";
export type { ErrorInfo as ClassroomErrorInfo, GoogleStatus as ClassroomErrorStatus } from "./errors.ts";
