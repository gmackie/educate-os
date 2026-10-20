import type { DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD } from "./northfield";
import { RIVERBEND } from "./riverbend";

export { NORTHFIELD } from "./northfield";
export { RIVERBEND } from "./riverbend";

/**
 * Both synthetic districts. They are meant to run as fully isolated instances: no ID, issuer or
 * identity link is shared between them, though one teacher's email and IdP subject deliberately
 * are.
 */
export const SYNTHETIC_DISTRICTS: readonly DistrictDirectorySnapshot[] = [NORTHFIELD, RIVERBEND];
