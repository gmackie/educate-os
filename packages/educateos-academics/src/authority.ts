import {
  AuthorityBindings,
  AuthorityDomain,
  EducateOsError,
  type Authority,
  type AuthorityBinding,
  type AuthorityMap,
  type GradeAuthority,
} from "@educateos/contracts";

/** The record types an `AuthorityMap` assigns a source of record to. */
export const DIRECTORY_ENTITY_KINDS = ["school", "term", "course", "offering", "enrollment", "principal"] as const;

/** One of {@link DIRECTORY_ENTITY_KINDS}. */
export type DirectoryEntityKind = (typeof DIRECTORY_ENTITY_KINDS)[number];

const PLURALS: Record<DirectoryEntityKind, string> = {
  school: "Schools",
  term: "Academic terms",
  course: "Catalog courses",
  offering: "Course offerings",
  enrollment: "Enrollments",
  principal: "Principals",
};

/**
 * Refuses a user-initiated write to a record type an external system owns, naming that system so
 * the caller knows where to make the change instead.
 */
export function assertLocallyWritable(authority: AuthorityMap, kind: DirectoryEntityKind): void {
  const owner = authority[kind];
  if (owner === "local") return;
  throw new EducateOsError(
    "conflict",
    `${PLURALS[kind]} are owned by ${owner}; change them there and let its sync update EducateOS.`,
  );
}

/** Refuses a sync write from a provider that does not own the record type. */
export function assertSyncWritable(authority: AuthorityMap, kind: DirectoryEntityKind, provider: string): void {
  const owner = authority[kind];
  if (owner === `external:${provider}`) return;
  throw new EducateOsError("conflict", `${PLURALS[kind]} are owned by ${owner}, not external:${provider}.`);
}

const DOMAIN_PLURALS: Record<AuthorityDomain, string> = {
  ...PLURALS,
  assignment: "Assignments",
  submission: "Submissions",
  grade: "Official grades",
  content: "Content resources",
};

/** The binding a source gets when nothing more is configured for it. */
function defaultBinding(source: Authority): AuthorityBinding {
  return source === "local"
    ? { source, writeMode: "read-write", syncDirection: "none", conflictPolicy: "refuse", allowedOperations: "all", revision: 1 }
    : { source, writeMode: "provider-only", syncDirection: "inbound", conflictPolicy: "source-wins", allowedOperations: "all", revision: 1 };
}

/**
 * The versioned authority bindings for a district whose directory is owned as `authority` says.
 * Assignments, submissions, grades and content are EducateOS's own unless `others` names their
 * source. Each binding is the default for its source: a local one accepts user writes, and an
 * external one is written only by its provider's inbound sync, whose version wins.
 */
export function bindingsFromAuthorityMap(
  authority: AuthorityMap,
  others: Partial<Record<Exclude<AuthorityDomain, DirectoryEntityKind>, Authority>> = {},
): AuthorityBindings {
  const sources: Record<AuthorityDomain, Authority> = {
    ...authority,
    assignment: others.assignment ?? "local",
    submission: others.submission ?? "local",
    grade: others.grade ?? "local",
    content: others.content ?? "local",
  };
  const domains = Object.fromEntries(AuthorityDomain.options.map((domain) => [domain, defaultBinding(sources[domain])]));
  return AuthorityBindings.parse({ version: 1, domains });
}

/**
 * Refuses an operation its domain's binding does not route, before it runs. An operation outside
 * the binding's `allowedOperations` is refused whether it reads or writes. A write to a domain
 * EducateOS does not hold as `read-write` is refused naming the owner, so the caller knows where
 * to make the change instead; reads of such a domain answer from EducateOS's projection. The
 * refusal is a `conflict`: the request is valid, but EducateOS is not where it can happen.
 */
export function assertOperationRoutable(
  bindings: AuthorityBindings,
  domain: AuthorityDomain,
  operation: { name: string; writes: boolean },
): void {
  const binding = bindings.domains[domain];
  if (binding.allowedOperations !== "all" && !binding.allowedOperations.includes(operation.name)) {
    throw new EducateOsError(
      "conflict",
      `${operation.name} is not routed to ${binding.source} for ${DOMAIN_PLURALS[domain].toLowerCase()}.`,
    );
  }
  if (!operation.writes || binding.writeMode === "read-write") return;
  throw new EducateOsError(
    "conflict",
    binding.writeMode === "provider-only"
      ? `${DOMAIN_PLURALS[domain]} are owned by ${binding.source}; change them there and let its sync update EducateOS.`
      : `${DOMAIN_PLURALS[domain]} are owned by ${binding.source} and are read-only in EducateOS.`,
  );
}

/**
 * The binding one offering's official grades are held under: the district's `grade` binding,
 * refined by the offering's own grade authority. The offering's setting only ever narrows what the
 * district allows, so it never makes grades locally writable where the district does not:
 *
 * - where EducateOS holds the district's grades, a class may keep them too (`local`), or hold
 *   them in an LMS (`lms:<provider>`), which EducateOS then publishes teacher-approved grades to:
 *   the same binding, syncing `outbound`. Who may write EducateOS's records is unchanged;
 * - where an external system holds them, a class may name only that system (`lms:<provider>` for
 *   `external:<provider>`), and its binding is the district's as it stands. A class that would keep
 *   its grades locally, or in another system, is refused with a `conflict` naming the owner.
 */
export function gradeBindingForOffering(district: AuthorityBinding, offering: GradeAuthority): AuthorityBinding {
  if (district.source === "local") {
    if (offering === "local") return district;
    return { ...district, syncDirection: district.syncDirection === "none" ? "outbound" : district.syncDirection };
  }
  if (offering === `lms:${district.source.slice("external:".length)}`) return district;
  throw new EducateOsError(
    "conflict",
    offering === "local"
      ? `Official grades are owned by ${district.source} for the whole district, so a class cannot keep them in EducateOS.`
      : `Official grades are owned by ${district.source} for the whole district, so a class cannot keep them in ${offering}.`,
  );
}
