// The stable input types of every fake: the synthetic district a caller seeds them with, the fault
// specifications they accept, and the fetch-handler shape they share. Demo districts (SCHO-202)
// build `DistrictSeed`s against these types, so change them only additively.
//
// A seed is vendor-neutral. Each fake projects it into its own wire format and derives the vendor's
// identifiers from the seed's `id`s deterministically (see `ids.ts`), so one seed can back a Clever,
// a OneRoster, a Google Classroom and an LTI fake at once and the same person is recognisably the
// same in each. Every email address and URL in a seed must be on a reserved `.example` domain;
// `validateSeed` enforces it.

/** A fake: a fetch handler over one provider's API. */
export type FakeHandler = (request: Request) => Promise<Response>;

/** The time in milliseconds since the epoch. Injected so tests control token expiry and paging. */
export type Clock = () => number;

/** A seed record's lifecycle status, as OneRoster spells it. */
export type SeedStatus = "active" | "tobedeleted";

/** Fields every seeded record may carry. */
export interface SeedRecord {
  /** A stable identifier, unique within its collection. Vendor identifiers are derived from it. */
  readonly id: string;
  /** When the record last changed, ISO 8601. Defaults to the seed's {@link DistrictSeed.modified}. */
  readonly modified?: string;
  /** Defaults to `active`. */
  readonly status?: SeedStatus;
}

/** A school. */
export interface SchoolSeed extends SeedRecord {
  readonly name: string;
  /** The school's local number, such as `"104"`. */
  readonly schoolNumber?: string;
  /** Grades as OneRoster writes them: `"PK"`, `"KG"`, `"01"` … `"12"`. */
  readonly lowGrade?: string;
  readonly highGrade?: string;
}

/** An academic session: a school year and the terms or grading periods within it. */
export interface TermSeed extends SeedRecord {
  readonly name: string;
  readonly type: "schoolYear" | "semester" | "term" | "gradingPeriod";
  /** ISO dates, `YYYY-MM-DD`. */
  readonly startDate: string;
  readonly endDate: string;
  /** The enclosing session, such as a semester's school year. */
  readonly parentId?: string;
  /** The school year it ends in, such as `"2027"` for 2026–27. */
  readonly schoolYear: string;
}

/** A course: what a school offers, of which sections are the taught instances. */
export interface CourseSeed extends SeedRecord {
  readonly title: string;
  readonly schoolId: string;
  readonly courseCode?: string;
  readonly subject?: string;
  readonly grades?: readonly string[];
}

/** A section (a OneRoster class, a Google Classroom course, an LTI context) and its roster. */
export interface SectionSeed extends SeedRecord {
  readonly title: string;
  readonly courseId: string;
  readonly schoolId: string;
  /** At least one. */
  readonly termIds: readonly string[];
  readonly period?: string;
  readonly room?: string;
  readonly subject?: string;
  readonly grades?: readonly string[];
  /** People with role `teacher`. The first is the primary teacher. */
  readonly teacherIds: readonly string[];
  /** People with role `student`. */
  readonly studentIds: readonly string[];
}

/** The roles a seeded person can have. */
export type PersonRole = "student" | "teacher" | "staff" | "administrator" | "guardian";

/** A person: a student, a teacher, staff, an administrator, or a student's guardian (a contact). */
export interface PersonSeed extends SeedRecord {
  readonly role: PersonRole;
  readonly givenName: string;
  readonly familyName: string;
  readonly middleName?: string;
  /** On a `.example` domain. */
  readonly email: string;
  /** Defaults to the email's local part. */
  readonly username?: string;
  /** The schools the person belongs to; the first is primary. Guardians may have none. */
  readonly schoolIds: readonly string[];
  /** A student's grade level, as OneRoster writes it (`"09"`). */
  readonly grade?: string;
  /** The district's own number for the person: a student or staff number. */
  readonly localId?: string;
  /** A guardian's students, by person ID. */
  readonly guardianOf?: readonly string[];
  /** A guardian's relationship to their students. Defaults to `guardian`. */
  readonly relationship?: "parent" | "guardian" | "relative" | "aunt/uncle" | "grandparent" | "sibling" | "other";
}

/** A student's turned-in work on an assignment, for the Classroom and LTI grade fakes. */
export interface SubmissionSeed {
  readonly studentId: string;
  /** Google Classroom's submission states. Defaults to `CREATED`. */
  readonly state?: "NEW" | "CREATED" | "TURNED_IN" | "RETURNED" | "RECLAIMED_BY_STUDENT";
  readonly draftGrade?: number;
  readonly assignedGrade?: number;
  readonly late?: boolean;
}

/** An assignment in a section: Classroom coursework, or an LTI AGS line item. */
export interface AssignmentSeed extends SeedRecord {
  readonly sectionId: string;
  readonly title: string;
  readonly description?: string;
  readonly maxPoints?: number;
  /** Defaults to `PUBLISHED`. */
  readonly state?: "PUBLISHED" | "DRAFT";
  /** ISO 8601. */
  readonly dueAt?: string;
  /**
   * Whether the integration's own app created it. Google lets an app change only coursework its
   * Cloud project created (`associatedWithDeveloper`). Defaults to false: a teacher made it.
   */
  readonly createdByIntegration?: boolean;
  readonly submissions?: readonly SubmissionSeed[];
}

/** A synthetic district: everything the fakes serve. */
export interface DistrictSeed {
  /** A short stable slug, such as `cedarvalley`. */
  readonly id: string;
  readonly name: string;
  /** The district's reserved domain, such as `cedarvalley.example`. Every email is under `.example`. */
  readonly domain: string;
  /** The default `modified` of every record, ISO 8601. */
  readonly modified: string;
  readonly schools: readonly SchoolSeed[];
  readonly terms: readonly TermSeed[];
  readonly courses: readonly CourseSeed[];
  readonly sections: readonly SectionSeed[];
  readonly people: readonly PersonSeed[];
  readonly assignments?: readonly AssignmentSeed[];
}

// ── Faults ─────────────────────────────────────────────────────────

/** Which requests a fault applies to. Every given field must match; none given matches all. */
export interface FaultMatch {
  /** A request method, such as `GET`. */
  readonly method?: string;
  /** A substring of, or a pattern tested against, the request's path. */
  readonly path?: string | RegExp;
}

/** The fault kinds every fake supports. */
export type FaultSpec =
  /** The provider is down: a 5xx (default 503) with the provider's own error body. */
  | { readonly kind: "outage"; readonly status?: 500 | 502 | 503 | 504; readonly times?: number; readonly match?: FaultMatch }
  /** Rate limited: a 429 with `Retry-After` in seconds, and the provider's own error body. */
  | { readonly kind: "rate-limit"; readonly retryAfterSeconds: number; readonly times?: number; readonly match?: FaultMatch }
  /** The connection fails before any response: the fetch rejects with a `TypeError`. */
  | { readonly kind: "network-error"; readonly times?: number; readonly match?: FaultMatch }
  /**
   * The next list response carries one record that breaks the provider's schema (a missing
   * required field, a wrong type). The fake decides which field, faithfully to how its vendor's
   * data goes wrong; the rest of the page is intact.
   */
  | { readonly kind: "malformed-record"; readonly times?: number; readonly match?: FaultMatch }
  /**
   * A large share of the roster disappears at once, as when an SIS export is truncated: `fraction`
   * (0–1) of the students, and their enrollments, are removed from what the fake serves (marked
   * `tobedeleted` where the API has the status, and as `deleted` events where it has events).
   */
  | { readonly kind: "large-removal"; readonly fraction: number };

/** A fault with a remaining count, as {@link FaultSpec} `times` (default unlimited) counts down. */
export type ActiveFault = FaultSpec & { remaining: number };

// ── Requests ───────────────────────────────────────────────────────

/** A request a fake received, for assertions. The body is the raw text. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/** What every fake exposes beyond its handler. */
export interface ProviderFake {
  /** Serves one request. */
  readonly handle: FakeHandler;
  /** A `fetch` serving this fake, for clients that take one. */
  readonly fetch: typeof globalThis.fetch;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[];
  /** Adds a fault. Returns a function removing it. */
  inject(fault: FaultSpec): () => void;
  /** Removes every fault. */
  clearFaults(): void;
}
