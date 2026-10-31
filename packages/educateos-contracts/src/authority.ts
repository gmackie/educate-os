import { z } from "zod";
import { ProviderName } from "./primitives.ts";

/**
 * Which system owns a directory record type. `local` means EducateOS is authoritative and accepts
 * user writes. `external:<provider>` means a roster or LMS is, and only that provider's sync adapter
 * may write: EducateOS keeps a projection, never a competing copy (roadmap §6.3).
 */
export const Authority = z.union([z.literal("local"), z.templateLiteral(["external:", ProviderName])]);
/** A source of record. */
export type Authority = z.infer<typeof Authority>;

/** The source of record for every directory record type. Every type must be stated; none defaults. */
export const AuthorityMap = z.strictObject({
  school: Authority,
  term: Authority,
  course: Authority,
  offering: Authority,
  enrollment: Authority,
  principal: Authority,
});
/** The source of record for each directory record type. */
export type AuthorityMap = z.infer<typeof AuthorityMap>;

/**
 * Which system holds an offering's official grades. `local` means EducateOS does, and nothing is
 * sent to an LMS. `lms:<provider>` means the named LMS does, and EducateOS only publishes
 * teacher-approved grades to it. The form follows {@link Authority}, with `lms:` because only an LMS
 * can hold a gradebook.
 */
export const GradeAuthority = z.union([z.literal("local"), z.templateLiteral(["lms:", ProviderName])]);
/** A grade authority. */
export type GradeAuthority = z.infer<typeof GradeAuthority>;

/**
 * The data domains a source of record is bound for (RFC 0002 §4): the directory's record types,
 * plus assignments, student submissions, official grades and content resources.
 */
export const AuthorityDomain = z.enum([
  "school",
  "term",
  "course",
  "offering",
  "enrollment",
  "principal",
  "assignment",
  "submission",
  "grade",
  "content",
]);
/** An authority domain. */
export type AuthorityDomain = z.infer<typeof AuthorityDomain>;

/**
 * Who may write a domain's records through EducateOS. `read-write`: users, through EducateOS's
 * own operations. `provider-only`: only the source's sync adapter. `read-only`: nobody; EducateOS
 * holds a projection it never changes.
 */
export const WriteMode = z.enum(["read-write", "provider-only", "read-only"]);
/** A write mode. */
export type WriteMode = z.infer<typeof WriteMode>;

/**
 * Which way records move between EducateOS and the source. `inbound`: the source's changes are
 * synced in. `outbound`: EducateOS publishes to another system, such as teacher-approved grades
 * to an LMS. `none`: nothing moves.
 */
export const SyncDirection = z.enum(["none", "inbound", "outbound", "bidirectional"]);
/** A sync direction. */
export type SyncDirection = z.infer<typeof SyncDirection>;

/**
 * What happens when a record changed on both sides. `source-wins`: the source's version replaces
 * EducateOS's. `quarantine`: the change waits for a person. `refuse`: the write fails with a
 * conflict, and nothing is overwritten.
 */
export const ConflictPolicy = z.enum(["source-wins", "quarantine", "refuse"]);
/** A conflict policy. */
export type ConflictPolicy = z.infer<typeof ConflictPolicy>;

/** A snake_case operation name, as operation descriptors use. */
const OperationName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "expected a snake_case operation name");

/**
 * One domain's source of record and how it may be used (RFC 0002 §4). `source` is the system that
 * owns the domain; a binding never moves authority on its own, for example to `local` while the
 * source is unreachable. Its shape keeps the rules that make a binding coherent: a `local` source
 * is `read-write` and syncs nothing in, and an external one is never `read-write`.
 */
export const AuthorityBinding = z.strictObject({
  /** The source of record. */
  source: Authority,
  /** Who may write the domain's records through EducateOS. */
  writeMode: WriteMode,
  /** Which way records move between EducateOS and the source. */
  syncDirection: SyncDirection,
  /** What happens when a record changed on both sides. */
  conflictPolicy: ConflictPolicy,
  /** The operations routed to this binding: `all` of the domain's, or only those named. */
  allowedOperations: z.union([z.literal("all"), z.array(OperationName).min(1)]),
  /** Increases with every change to the binding, so a decision can name the binding it relied on. */
  revision: z.int().positive(),
}).superRefine((binding, ctx) => {
  const local = binding.source === "local";
  if (local && binding.writeMode !== "read-write") {
    ctx.addIssue({ code: "custom", path: ["writeMode"], message: "a local source is read-write" });
  }
  if (local && (binding.syncDirection === "inbound" || binding.syncDirection === "bidirectional")) {
    ctx.addIssue({ code: "custom", path: ["syncDirection"], message: "a local source has nothing to sync in" });
  }
  if (!local && binding.writeMode === "read-write") {
    ctx.addIssue({ code: "custom", path: ["writeMode"], message: "an external source is written only by its provider" });
  }
});
/** An authority binding. */
export type AuthorityBinding = z.infer<typeof AuthorityBinding>;

/**
 * The versioned authority bindings of a district: one binding for every {@link AuthorityDomain},
 * none defaulted. It extends {@link AuthorityMap}, which still states the directory's record types
 * where deployments configure them; `bindingsFromAuthorityMap` derives these from one.
 */
export const AuthorityBindings = z.strictObject({
  /** The shape's version. */
  version: z.literal(1),
  /** Each domain's binding. */
  domains: z.strictObject(
    Object.fromEntries(AuthorityDomain.options.map((domain) => [domain, AuthorityBinding])) as Record<AuthorityDomain, typeof AuthorityBinding>,
  ),
});
/** A district's authority bindings. */
export type AuthorityBindings = z.infer<typeof AuthorityBindings>;
