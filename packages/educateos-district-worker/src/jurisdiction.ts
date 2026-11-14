// The district's data jurisdiction (SCHO-374, ADR-0015): the Cloudflare jurisdiction its Durable
// Object is created and kept in. It comes from the `DATA_JURISDICTION` var, which the installer
// sets on a new install. Unset, the object is unpinned, which is where every district deployed
// before ADR-0015 keeps its data: a jurisdiction is part of an object's ID, so the same name in
// another jurisdiction is another, empty object, and pinning an existing district would lose it.
//
// This module imports nothing Workers-only, so it is type-checked with the web-standard surface.

/** The jurisdictions a district's storage can be pinned to. */
export const DATA_JURISDICTIONS = ["us"] as const;

/** A jurisdiction a district's storage can be pinned to. */
export type DataJurisdiction = (typeof DATA_JURISDICTIONS)[number];

/**
 * The jurisdiction `DATA_JURISDICTION` names, or undefined when it is unset or empty (an unpinned
 * district). Any other value throws: a district never guesses where its data lives.
 */
export function readDataJurisdiction(value: string | undefined): DataJurisdiction | undefined {
  if (value === undefined || value === "") return undefined;
  if ((DATA_JURISDICTIONS as readonly string[]).includes(value)) return value as DataJurisdiction;
  throw new Error(`DATA_JURISDICTION must be unset or one of ${DATA_JURISDICTIONS.join(", ")}, not ${JSON.stringify(value)}`);
}

/** A Durable Object namespace, as far as restricting it to a jurisdiction goes. */
export interface JurisdictionalNamespace<N> {
  jurisdiction(jurisdiction: DataJurisdiction): N;
}

/**
 * The namespace to name objects in: restricted to `jurisdiction` when there is one, so every ID made
 * from it is created and kept there, or else the namespace itself.
 */
export function inJurisdiction<N extends JurisdictionalNamespace<N>>(namespace: N, jurisdiction: DataJurisdiction | undefined): N {
  return jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction);
}
