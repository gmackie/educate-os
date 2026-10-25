// Named, publisher-specific CASE adapters (ADR-0011). The CASE 1.1 schemas stay strict: an unknown
// field still fails closed. An adapter handles only deviations it names, in fields CASE already
// defines, and reports every change it makes so the decoder can record it on the record's
// provenance. A publisher without an adapter is decoded exactly as before.
import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import { RegistryIdentifier } from "../framework.ts";
import { ProvenanceAdaptation } from "../primitives.ts";
import { TEA_TEKS_ADAPTER } from "./tea-teks.ts";
import { CaseDocumentSet, CasePackage } from "./wire.ts";

/** The record an adaptation changed: the package's document, one of its items, or a listing. */
export const AdaptationTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("document"), identifier: RegistryIdentifier }),
  z.strictObject({ kind: z.literal("item"), identifier: RegistryIdentifier }),
  z.strictObject({ kind: z.literal("listing") }),
]);
/** An adaptation target. */
export type AdaptationTarget = z.infer<typeof AdaptationTarget>;

/** One change an adapter made, and the record it made it in. */
export const CaseAdaptation = z.strictObject({
  ...ProvenanceAdaptation.shape,
  target: AdaptationTarget,
});
/** A CASE adaptation. */
export type CaseAdaptation = z.infer<typeof CaseAdaptation>;

/** A CASE response after an adapter normalized it, with every change it made. */
export interface Adapted<T> {
  value: T;
  adaptations: CaseAdaptation[];
}

/**
 * A named adapter for one publisher's known deviations from CASE 1.1. It receives the raw JSON
 * and returns JSON that the strict CASE 1.1 schemas then validate; it must not touch anything it
 * does not report.
 */
export interface CaseAdapter {
  /** `<name>@<version>`, as recorded on every adaptation. */
  readonly id: string;
  /** Normalizes a `GET /CFPackages/{id}` response. */
  adaptPackage(raw: unknown): Adapted<unknown>;
  /** Normalizes a `GET /CFDocuments` response. */
  adaptDocumentSet(raw: unknown): Adapted<unknown>;
}

function strictly<T extends z.ZodType>(schema: T, adapted: Adapted<unknown>, adapter: CaseAdapter, what: string): Adapted<z.infer<T>> {
  const adaptations = z.array(CaseAdaptation).safeParse(adapted.adaptations);
  if (!adaptations.success || adaptations.data.some((a) => a.adapter !== adapter.id)) {
    throw new EducateOsError("validation-failed", `adapter ${adapter.id} reported malformed adaptations`);
  }
  const value = schema.safeParse(adapted.value);
  if (!value.success) {
    const paths = value.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new EducateOsError("validation-failed", `${what} is not CASE 1.1 after ${adapter.id}: ${paths.join("; ")}`);
  }
  return { value: value.data, adaptations: adaptations.data };
}

/**
 * Runs `adapter` over a raw package and validates the result as strict CASE 1.1.
 *
 * @throws EducateOsError `validation-failed` if the result is still not CASE 1.1 (an unknown field,
 *   or a deviation the adapter does not name), or the adapter reports malformed adaptations.
 */
export function adaptCasePackage(raw: unknown, adapter: CaseAdapter): Adapted<CasePackage> {
  return strictly(CasePackage, adapter.adaptPackage(structuredClone(raw)), adapter, "CASE package");
}

/**
 * Runs `adapter` over a raw `CFDocuments` listing and validates the result as strict CASE 1.1.
 *
 * @throws EducateOsError `validation-failed` as for {@link adaptCasePackage}.
 */
export function adaptCaseDocumentSet(raw: unknown, adapter: CaseAdapter): Adapted<CaseDocumentSet> {
  return strictly(CaseDocumentSet, adapter.adaptDocumentSet(structuredClone(raw)), adapter, "CASE document listing");
}

/** The adapters the registry ships, by name. A catalog source names the one its publisher needs. */
export const CaseAdapterName = z.enum(["tea-teks-api"]);
/** A shipped adapter's name. */
export type CaseAdapterName = z.infer<typeof CaseAdapterName>;

const ADAPTERS: Readonly<Record<CaseAdapterName, CaseAdapter>> = { "tea-teks-api": TEA_TEKS_ADAPTER };

/** The shipped adapter with this name. */
export function caseAdapter(name: CaseAdapterName): CaseAdapter {
  return ADAPTERS[name];
}
