import type { DistrictDirectorySnapshot } from "@educateos/contracts";
import { NORTHFIELD } from "./northfield.ts";
import { RIVERBEND } from "./riverbend.ts";

export { NORTHFIELD } from "./northfield.ts";
export { RIVERBEND } from "./riverbend.ts";

/**
 * Both synthetic districts. They are meant to run as fully isolated instances: no ID, issuer or
 * identity link is shared between them, though one teacher's email and IdP subject deliberately
 * are.
 */
export const SYNTHETIC_DISTRICTS: readonly DistrictDirectorySnapshot[] = [NORTHFIELD, RIVERBEND];
