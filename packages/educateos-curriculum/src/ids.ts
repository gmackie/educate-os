import { Scope } from "@educateos/contracts";
import { z } from "zod";

/** An offering scope: where an activity is installed and taught. */
export const OfferingScope = Scope.options[2];
/** An offering scope. */
export type OfferingScope = z.infer<typeof OfferingScope>;

/** An activity scope: one installed activity within its offering. */
export const ActivityScope = Scope.options[3];
/** An activity scope. */
export type ActivityScope = z.infer<typeof ActivityScope>;

/** A kebab-case identifier for an entry within a definition, such as a step or a Codex note. */
export const LocalId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "expected a kebab-case ID");
/** A local identifier. */
export type LocalId = z.infer<typeof LocalId>;
