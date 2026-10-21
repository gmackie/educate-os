// SchoolOS policy (roadmap A02): the ABAC engine behind the contracts' `Authorizer` seam, its
// content-free audit trail, and the school tool contract that re-authorizes every tool call.
export * from "./rules.ts";
export * from "./information.ts";
export * from "./audit.ts";
export * from "./engine.ts";
export * from "./approvals.ts";
export * from "./tools.ts";
export * from "./grants.ts";
export * from "./academics.ts";
