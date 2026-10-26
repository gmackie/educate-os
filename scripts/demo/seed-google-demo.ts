// Seeds the Google Workspace for Education demo tenant (gedu.demo.educateos.io) with the synthetic
// Harbor Charter and Cedar Valley USD districts from @educateos/fixtures (SCHO-202): their
// organizational units, one account per staff member and student, and one Classroom course per
// offering, owned by its lead teacher, with its roster. `googleDemoPlan` decides what should exist;
// this script makes the tenant match it.
//
//   node scripts/demo/seed-google-demo.ts --dry-run   read the tenant and print what would change
//   node scripts/demo/seed-google-demo.ts             create or repair everything in the plan
//   node scripts/demo/seed-google-demo.ts --verify    check, as the read-only classroom-sync account,
//                                                     that every course and roster is visible
//   node scripts/demo/seed-google-demo.ts --delete    delete the plan's courses, accounts and units
//
// Idempotent: every object is keyed on a fixture ID. An account's primary email is the principal's
// ID body (`hb-teacher-asante@gedu.demo.educateos.io`) and carries the principal ID as an external
// ID; a course's alias is `d:<offering ID>`. A rerun creates what is missing, repairs drift (a
// moved account, a renamed or inactive course, a roster change) and leaves everything else alone.
// A planned course's roster is made exact, so anyone added to it by hand is removed. An existing
// account is touched only when its primary email and fixture external ID both match the plan, so
// an alias on some other account is never moved or deleted. `--delete` touches only planned objects.
//
// It acts as the `demo-provisioner` service account through domain-wide delegation, impersonating
// the tenant admin for directory and roster calls and each lead teacher to create that teacher's
// course. The key is read from the macOS Keychain on every run and never printed or written to
// disk. Every account gets a random password that is never printed. Only the accounts in
// TEST_ACCOUNTS, needed for hands-on testing, have theirs stored, in the Keychain under
// `educateos-gedu-demo-<ID body>`; the rest are never stored anywhere.
//
// Owner step with no API: in the Admin console, set the age label of /Harbor/Staff and
// /CedarValley/Staff to "18 or older". Students stay under 18. The script prints this reminder.
import { execFileSync, spawnSync } from "node:child_process";
import { createSign, randomInt } from "node:crypto";
import { DEMO_DISTRICTS, googleDemoPlan, type GoogleCoursePlan, type GoogleDemoPlan, type GoogleUserPlan } from "../../packages/educateos-fixtures/src/index.ts";

/** The demo tenant's domain. */
export const DOMAIN = "gedu.demo.educateos.io";
/** The tenant admin the provisioner impersonates. */
export const ADMIN = `gmackie@${DOMAIN}`;
/** Keychain service holding the provisioner's key, as base64 JSON. */
const PROVISIONER_KEY = "educateos-demo-provisioner-sa-key";
/** Keychain service holding the read-only classroom-sync account's key, as base64 JSON. */
const SYNC_KEY = "educateos-classroom-demo-sa-key";
/** The scopes the provisioner's delegation grants. */
const PROVISIONER_SCOPES = ["admin.directory.user", "admin.directory.orgunit", "classroom.courses", "classroom.rosters"];
/** The accounts whose passwords are kept, for signing in by hand: a teacher and a student in Harbor, a Cedar Valley teacher. */
export const TEST_ACCOUNTS = ["prn_hb-teacher-asante", "prn_hb-student-nia", "prn_cv-teacher-whitaker"] as const;
/** The external ID type that records which fixture principal an account is. */
const FIXTURE_ID_TYPE = "educateos-fixture-id";

const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const CLASSROOM = "https://classroom.googleapis.com/v1";

/** The Keychain service of a test account's password. */
export function keychainService(primaryEmail: string): string {
  return `educateos-gedu-demo-${primaryEmail.slice(0, primaryEmail.indexOf("@"))}`;
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random 24-character password from an alphabet that needs no quoting anywhere. */
export function randomPassword(): string {
  return Array.from({ length: 24 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");
}

/**
 * The `security -i` command that stores a password. It is sent on stdin, never as an argument, so
 * the password does not appear in the process list. Every value is checked to need no quoting.
 */
export function keychainAddCommand(service: string, account: string, password: string): string {
  for (const value of [service, account, password]) {
    if (!/^[A-Za-z0-9@._-]+$/.test(value)) throw new Error("refusing to store a Keychain value that would need quoting");
  }
  return `add-generic-password -U -s "${service}" -a "${account}" -l "${service}" -w "${password}"\n`;
}

/** A Directory API org unit path, as the `orgunits/{path}` URL segment wants it. */
export function orgUnitUrlPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** What to add to and remove from a roster so it holds exactly `planned`. */
export function rosterChanges(planned: readonly string[], actual: readonly string[]): { add: string[]; remove: string[] } {
  const want = new Set(planned);
  const have = new Set(actual);
  return { add: planned.filter((id) => !have.has(id)), remove: actual.filter((id) => !want.has(id)) };
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** Reads a service account key from the Keychain. The value goes nowhere but memory. */
function keyFromKeychain(service: string): ServiceAccountKey {
  const encoded = execFileSync("security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8")) as ServiceAccountKey;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** An error from a Google API, with its HTTP status and Google's own message (never a request body). */
class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Domain-wide-delegation tokens for one service account, one per impersonated user. */
class Delegation {
  readonly #key: ServiceAccountKey;
  readonly #scopes: string[];
  readonly #tokens = new Map<string, { token: string; expires: number }>();

  constructor(key: ServiceAccountKey, scopes: readonly string[]) {
    this.#key = key;
    this.#scopes = scopes.map((s) => `https://www.googleapis.com/auth/${s}`);
  }

  async token(subject: string): Promise<string> {
    const cached = this.#tokens.get(subject);
    if (cached !== undefined && cached.expires > Date.now() + 60_000) return cached.token;
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
      iss: this.#key.client_email,
      sub: subject,
      scope: this.#scopes.join(" "),
      aud: this.#key.token_uri,
      iat,
      exp: iat + 3600,
    }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.#key.private_key);
    const response = await fetch(this.#key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || body.access_token === undefined) {
      throw new GoogleApiError(response.status, `token for ${subject}: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
    }
    this.#tokens.set(subject, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Google API client acting as `subject`. Retries rate limits and server errors; a GET's 404 reads as undefined. */
function client(delegation: Delegation, subject: string) {
  async function call<T>(method: string, url: string, body?: unknown): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${await delegation.token(subject)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // A GET's 404 means absent; a DELETE's means already gone, as after a retried DELETE.
      if (response.status === 404 && (method === "GET" || method === "DELETE")) return undefined;
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        let message = text.slice(0, 200);
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {}
        throw new GoogleApiError(response.status, `${method} ${url.replace(/\?.*$/, "")} as ${subject}: ${response.status} ${message}`);
      }
      return (text === "" ? {} : JSON.parse(text)) as T;
    }
  }
  return {
    get: <T>(url: string) => call<T>("GET", url),
    post: <T>(url: string, body: unknown) => call<T>("POST", url, body),
    patch: <T>(url: string, body: unknown) => call<T>("PATCH", url, body),
    delete: (url: string) => call<unknown>("DELETE", url),
  };
}
type Client = ReturnType<typeof client>;

/**
 * Retries `action` while Google has not yet caught up with a just-created or just-removed account
 * (Classroom answers 403 or 404 for a few minutes), every 30 seconds, `attempts` more times.
 */
async function whenPropagated<T>(what: string, action: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof GoogleApiError) || ![403, 404].includes(error.status) || attempt >= attempts) throw error;
      console.log(`  waiting for Google to propagate ${what} (${error.status})`);
      await sleep(30_000);
    }
  }
}

/** Treats a 409 as success: a create retried after a lost response finds its own earlier result. */
async function alreadyExistsIsFine<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 409) return undefined;
    throw error;
  }
}

interface DirectoryUser {
  id: string;
  primaryEmail: string;
  orgUnitPath: string;
  name: { givenName: string; familyName: string };
  externalIds?: { type: string; customType?: string; value: string }[];
}

const fixtureIdOf = (user: DirectoryUser) => user.externalIds?.find((x) => x.customType === FIXTURE_ID_TYPE)?.value;

/**
 * The planned account, if it exists and really is it. `users.get` also answers for an alias, so
 * an account found under another primary email, or carrying another fixture ID, is refused rather
 * than moved, renamed or deleted. An account with no fixture ID yet (one made before this field) is
 * accepted under its own primary email, and the seed then adds the ID.
 */
async function plannedAccount(admin: Client, user: GoogleUserPlan): Promise<DirectoryUser | undefined> {
  const found = await admin.get<DirectoryUser>(usersUrl(user.primaryEmail));
  if (found === undefined) return undefined;
  const fixtureId = fixtureIdOf(found);
  if (found.primaryEmail.toLowerCase() !== user.primaryEmail || (fixtureId !== undefined && fixtureId !== user.fixtureId)) {
    throw new Error(`${user.primaryEmail} resolves to ${found.primaryEmail} (${fixtureId ?? "no fixture ID"}), which is not the planned ${user.fixtureId}; refusing to touch it`);
  }
  return found;
}

interface Course {
  id: string;
  name: string;
  section?: string;
  ownerId: string;
  courseState: string;
}

type Outcome = "created" | "updated" | "unchanged" | "deleted";
/** Tallies of what a run did (or, dry, would do), by object kind. */
type Tally = Record<string, Record<Outcome, number>>;

function count(t: Tally, kind: string, outcome: Outcome, n = 1): void {
  t[kind] ??= { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  t[kind][outcome] += n;
}

function keychainHas(service: string): boolean {
  return spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore" }).status === 0;
}

function keychainStore(service: string, account: string, password: string): void {
  const result = spawnSync("security", ["-i"], { input: keychainAddCommand(service, account, password), stdio: ["pipe", "ignore", "ignore"] });
  // `security -i` can exit 0 when its command fails, so the item is looked up afterwards too.
  if (result.status !== 0 || !keychainHas(service)) throw new Error(`could not store ${service} in the Keychain`);
}

const usersUrl = (email: string) => `${DIRECTORY}/users/${encodeURIComponent(email)}`;
const orgUnitUrl = (path: string) => `${DIRECTORY}/customer/my_customer/orgunits/${orgUnitUrlPath(path)}`;
const courseUrl = (idOrAlias: string) => `${CLASSROOM}/courses/${encodeURIComponent(idOrAlias)}`;

async function listAll<T>(api: Client, url: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.get<Record<string, unknown>>(`${url}?pageSize=100${pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`}`);
    out.push(...((page?.[field] as T[] | undefined) ?? []));
    pageToken = (page?.nextPageToken as string | undefined) || undefined;
  } while (pageToken !== undefined);
  return out;
}

async function seedOrgUnits(admin: Client, plan: GoogleDemoPlan, dryRun: boolean, t: Tally): Promise<void> {
  for (const unit of plan.orgUnits) {
    if ((await admin.get(orgUnitUrl(unit.path))) !== undefined) {
      count(t, "org units", "unchanged");
      continue;
    }
    console.log(`${dryRun ? "would create" : "create"} org unit ${unit.path}`);
    if (!dryRun) await alreadyExistsIsFine(admin.post(`${DIRECTORY}/customer/my_customer/orgunits`, { name: unit.name, parentOrgUnitPath: unit.parentPath, description: unit.description }));
    count(t, "org units", "created");
  }
}

function accountFields(user: GoogleUserPlan) {
  return {
    primaryEmail: user.primaryEmail,
    name: { givenName: user.givenName, familyName: user.familyName },
    orgUnitPath: user.orgUnitPath,
    externalIds: [{ type: "custom", customType: FIXTURE_ID_TYPE, value: user.fixtureId }],
  };
}

/** Creates or repairs each planned account, and returns each existing one's Google user ID by email. */
async function seedUsers(admin: Client, plan: GoogleDemoPlan, dryRun: boolean, t: Tally): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const testEmails = new Set(TEST_ACCOUNTS.map((id) => plan.users.find((u) => u.fixtureId === id)!.primaryEmail));
  for (const user of plan.users) {
    let existing = await plannedAccount(admin, user);
    const isTest = testEmails.has(user.primaryEmail);
    const service = keychainService(user.primaryEmail);
    if (existing === undefined) {
      console.log(`${dryRun ? "would create" : "create"} account ${user.primaryEmail} in ${user.orgUnitPath}${isTest ? ` (password kept as Keychain ${service})` : ""}`);
      count(t, "accounts", "created");
      if (dryRun) continue;
      const password = randomPassword();
      const created = await alreadyExistsIsFine(admin.post<DirectoryUser>(`${DIRECTORY}/users`, { ...accountFields(user), password, changePasswordAtNextLogin: false }));
      if (created !== undefined) {
        if (isTest) keychainStore(service, user.primaryEmail, password);
        ids.set(user.primaryEmail, created.id);
        continue;
      }
      // A retried create that already succeeded: treat it as existing, and reset a test password below.
      existing = (await plannedAccount(admin, user))!;
      spawnSync("security", ["delete-generic-password", "-s", service], { stdio: "ignore" });
    }
    ids.set(user.primaryEmail, existing.id);
    const drifted = existing.orgUnitPath !== user.orgUnitPath || fixtureIdOf(existing) !== user.fixtureId
      || existing.name.givenName !== user.givenName || existing.name.familyName !== user.familyName;
    if (drifted) {
      console.log(`${dryRun ? "would update" : "update"} account ${user.primaryEmail} (unit, name or fixture ID changed)`);
      if (!dryRun) await admin.patch(usersUrl(user.primaryEmail), accountFields(user));
    }
    if (isTest && !keychainHas(service)) {
      console.log(`${dryRun ? "would reset" : "reset"} the password of ${user.primaryEmail}, which the Keychain lacks (${service})`);
      if (!dryRun) {
        const password = randomPassword();
        await admin.patch(usersUrl(user.primaryEmail), { password, changePasswordAtNextLogin: false });
        keychainStore(service, user.primaryEmail, password);
      }
    }
    count(t, "accounts", drifted ? "updated" : "unchanged");
  }
  return ids;
}

/** Makes a course active: as the admin, or failing that as its owner. */
async function activate(delegation: Delegation, admin: Client, course: GoogleCoursePlan, courseId: string): Promise<void> {
  const url = `${courseUrl(courseId)}?updateMask=courseState`;
  try {
    await admin.patch(url, { courseState: "ACTIVE" });
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status >= 500) throw error;
    console.log(`  the admin could not activate ${course.alias} (${error.status}); activating it as ${course.ownerEmail}`);
    await whenPropagated(course.ownerEmail, () => client(delegation, course.ownerEmail).patch(url, { courseState: "ACTIVE" }));
  }
}

/**
 * Creates a course as its owner. If the owner may not create classes, the admin provisions it for
 * them instead and then activates it.
 */
async function createCourse(delegation: Delegation, admin: Client, course: GoogleCoursePlan): Promise<Course> {
  const owner = client(delegation, course.ownerEmail);
  const body = { id: course.alias, name: course.name, section: course.section };
  try {
    const created = await whenPropagated(course.ownerEmail, () => alreadyExistsIsFine(owner.post<Course>(`${CLASSROOM}/courses`, { ...body, ownerId: "me", courseState: "ACTIVE" })), 2);
    return created ?? (await admin.get<Course>(courseUrl(course.alias)))!;
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 403) throw error;
    console.log(`  ${course.ownerEmail} could not create the class (${error.message}); provisioning it as the admin`);
    const provisioned = (await alreadyExistsIsFine(admin.post<Course>(`${CLASSROOM}/courses`, { ...body, ownerId: course.ownerEmail, courseState: "PROVISIONED" })))
      ?? (await admin.get<Course>(courseUrl(course.alias)))!;
    await activate(delegation, admin, course, provisioned.id);
    return { ...provisioned, courseState: "ACTIVE" };
  }
}

async function seedCourses(delegation: Delegation, admin: Client, plan: GoogleDemoPlan, ids: Map<string, string>, dryRun: boolean, t: Tally): Promise<void> {
  const emailOf = new Map([...ids].map(([email, id]) => [id, email]));
  const verb = (doing: string) => (dryRun ? `would ${doing}` : doing);
  for (const course of plan.courses) {
    let existing = await admin.get<Course>(courseUrl(course.alias));
    if (existing === undefined) {
      console.log(`${verb("create")} course ${course.alias} "${course.name} (${course.section})" owned by ${course.ownerEmail}`);
      count(t, "courses", "created");
      if (dryRun) {
        count(t, "roster members", "created", 1 + course.coTeacherEmails.length + course.studentEmails.length);
        continue;
      }
      existing = await createCourse(delegation, admin, course);
    }
    const courseId = existing.id;
    let changed = false;
    if (existing.courseState !== "ACTIVE") {
      console.log(`${verb("activate")} course ${course.alias} (it is ${existing.courseState})`);
      if (!dryRun) await activate(delegation, admin, course, courseId);
      changed = true;
    }
    if (existing.name !== course.name || existing.section !== course.section) {
      console.log(`${verb("rename")} course ${course.alias}`);
      if (!dryRun) await admin.patch(`${courseUrl(courseId)}?updateMask=name,section`, { name: course.name, section: course.section });
      changed = true;
    }

    // Teachers are added before any ownership change, since a course's new owner must already
    // teach it, and removed only after it.
    const roster = async (kind: "teachers" | "students") =>
      (await listAll<{ userId: string }>(admin, `${courseUrl(courseId)}/${kind}`, kind)).map((m) => m.userId);
    const wantOwner = ids.get(course.ownerEmail) ?? course.ownerEmail;
    const teachers = rosterChanges([course.ownerEmail, ...course.coTeacherEmails].map((e) => ids.get(e) ?? e), await roster("teachers"));
    const students = rosterChanges(course.studentEmails.map((e) => ids.get(e) ?? e), await roster("students"));
    const add = async (kind: "teachers" | "students", id: string) => {
      const email = emailOf.get(id) ?? id;
      console.log(`${verb("add")} ${email} to ${course.alias} ${kind}`);
      if (!dryRun) await whenPropagated(email, () => alreadyExistsIsFine(admin.post(`${courseUrl(courseId)}/${kind}`, { userId: email })));
      count(t, "roster members", "created");
    };
    const remove = async (kind: "teachers" | "students", id: string) => {
      console.log(`${verb("remove")} ${emailOf.get(id) ?? id} from ${course.alias} ${kind}`);
      if (!dryRun) await admin.delete(`${courseUrl(courseId)}/${kind}/${encodeURIComponent(id)}`);
      count(t, "roster members", "deleted");
    };
    for (const id of teachers.add) await add("teachers", id);
    if (existing.ownerId !== wantOwner) {
      console.log(`${verb("transfer")} course ${course.alias} to ${course.ownerEmail}`);
      if (!dryRun) await admin.patch(`${courseUrl(courseId)}?updateMask=ownerId`, { ownerId: course.ownerEmail });
      changed = true;
    }
    for (const id of teachers.remove) await remove("teachers", id);
    for (const id of students.add) await add("students", id);
    for (const id of students.remove) await remove("students", id);
    count(t, "courses", changed ? "updated" : "unchanged");
  }
}

async function deleteAll(admin: Client, plan: GoogleDemoPlan, dryRun: boolean, t: Tally): Promise<void> {
  for (const course of plan.courses) {
    const existing = await admin.get<Course>(courseUrl(course.alias));
    if (existing === undefined) continue;
    console.log(`${dryRun ? "would delete" : "delete"} course ${course.alias}`);
    if (!dryRun) {
      try {
        await admin.delete(courseUrl(existing.id));
      } catch (error) {
        // Classroom may delete only an archived course: archive it, then try again.
        if (!(error instanceof GoogleApiError) || error.status !== 400) throw error;
        await admin.patch(`${courseUrl(existing.id)}?updateMask=courseState`, { courseState: "ARCHIVED" });
        await admin.delete(courseUrl(existing.id));
      }
    }
    count(t, "courses", "deleted");
  }
  for (const user of plan.users) {
    const service = keychainService(user.primaryEmail);
    if ((await plannedAccount(admin, user)) !== undefined) {
      console.log(`${dryRun ? "would delete" : "delete"} account ${user.primaryEmail}`);
      if (!dryRun) await admin.delete(usersUrl(user.primaryEmail));
      count(t, "accounts", "deleted");
    }
    if (keychainHas(service)) {
      console.log(`${dryRun ? "would delete" : "delete"} Keychain item ${service}`);
      if (!dryRun) spawnSync("security", ["delete-generic-password", "-s", service], { stdio: "ignore" });
    }
  }
  // Children first: a unit with sub-units or accounts cannot be deleted.
  for (const unit of plan.orgUnits.toReversed()) {
    if ((await admin.get(orgUnitUrl(unit.path))) === undefined) continue;
    console.log(`${dryRun ? "would delete" : "delete"} org unit ${unit.path}`);
    if (!dryRun) await whenPropagated(`the removal of the accounts in ${unit.path}`, () => admin.delete(orgUnitUrl(unit.path)));
    count(t, "org units", "deleted");
  }
}

/**
 * Checks, as the read-only classroom-sync account, that every planned course is active with the
 * planned owner and roster. Tries read-only scopes first, then the ones its delegation lists.
 */
async function verify(plan: GoogleDemoPlan): Promise<boolean> {
  const key = keyFromKeychain(SYNC_KEY);
  let delegation = new Delegation(key, ["admin.directory.user.readonly", "classroom.courses.readonly", "classroom.rosters.readonly"]);
  try {
    await delegation.token(ADMIN);
    console.log("classroom-sync: read-only scopes");
  } catch (error) {
    // Its delegation lists the full Classroom scopes, not the .readonly ones. This path makes GETs only.
    console.log(`classroom-sync: read-only scopes refused (${error instanceof Error ? error.message : error}); using its delegated scopes for GETs only`);
    delegation = new Delegation(key, ["admin.directory.user.readonly", "classroom.courses", "classroom.rosters"]);
  }
  const reader = client(delegation, ADMIN);
  const ids = new Map<string, string>();
  for (const user of plan.users) {
    const found = await reader.get<DirectoryUser>(usersUrl(user.primaryEmail));
    if (found !== undefined) ids.set(user.primaryEmail, found.id);
  }
  console.log(`classroom-sync sees ${ids.size}/${plan.users.length} accounts`);
  let ok = ids.size === plan.users.length;
  for (const course of plan.courses) {
    const found = await reader.get<Course>(courseUrl(course.alias));
    if (found === undefined) {
      console.log(`MISSING ${course.alias}`);
      ok = false;
      continue;
    }
    const roster = async (kind: "teachers" | "students") =>
      new Set((await listAll<{ userId: string }>(reader, `${courseUrl(found.id)}/${kind}`, kind)).map((m) => m.userId));
    const teachers = await roster("teachers");
    const students = await roster("students");
    const wantTeachers = [course.ownerEmail, ...course.coTeacherEmails].map((e) => ids.get(e));
    const wantStudents = course.studentEmails.map((e) => ids.get(e));
    const good = found.courseState === "ACTIVE" && found.ownerId === ids.get(course.ownerEmail)
      && teachers.size === wantTeachers.length && wantTeachers.every((id) => id !== undefined && teachers.has(id))
      && students.size === wantStudents.length && wantStudents.every((id) => id !== undefined && students.has(id));
    ok &&= good;
    console.log(`${good ? "ok   " : "WRONG"} ${course.alias.padEnd(22)} ${found.courseState.padEnd(11)} teachers ${teachers.size}/${wantTeachers.length}  students ${students.size}/${wantStudents.length}  ${course.name} (${course.section})`);
  }
  return ok;
}

function printTally(t: Tally): void {
  for (const [kind, counts] of Object.entries(t)) {
    console.log(`${kind}: ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set(["--dry-run", "--delete", "--verify"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(" ")}; expected --dry-run, --delete or --verify`);
    return 2;
  }
  const dryRun = argv.includes("--dry-run");
  const plan = googleDemoPlan(DOMAIN, DEMO_DISTRICTS);
  console.log(`plan for ${DOMAIN}: ${plan.orgUnits.length} org units, ${plan.users.length} accounts, ${plan.courses.length} courses${dryRun ? " (dry run)" : ""}`);

  if (argv.includes("--verify")) return (await verify(plan)) ? 0 : 1;

  const delegation = new Delegation(keyFromKeychain(PROVISIONER_KEY), PROVISIONER_SCOPES);
  const admin = client(delegation, ADMIN);
  const t: Tally = {};
  if (argv.includes("--delete")) {
    await deleteAll(admin, plan, dryRun, t);
    printTally(t);
    return 0;
  }
  await seedOrgUnits(admin, plan, dryRun, t);
  const ids = await seedUsers(admin, plan, dryRun, t);
  await seedCourses(delegation, admin, plan, ids, dryRun, t);
  printTally(t);
  const staff = plan.orgUnits.filter((u) => u.name === "Staff").map((u) => u.path);
  console.log(`\nOwner step (no API): in the Admin console, set the age label of ${staff.join(" and ")} to "18 or older". Students stay under 18.`);
  console.log(`Test account passwords are in the Keychain as ${TEST_ACCOUNTS.map((id) => keychainService(plan.users.find((u) => u.fixtureId === id)!.primaryEmail)).join(", ")}.`);
  return 0;
}

if (import.meta.main === undefined) {
  // Before Node 24.2 `import.meta.main` does not exist, and the script would silently do nothing.
  console.error("seed-google-demo.ts needs Node 24.2 or later");
  process.exitCode = 1;
} else if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
