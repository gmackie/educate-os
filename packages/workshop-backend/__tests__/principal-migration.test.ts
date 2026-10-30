// The one-time migration of email-keyed users to principals, by alias (SCHO-259): the planner over
// fakes, then the admin route and sign-in end to end over the real user and directory objects.
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { newHttpBatchRpcSession } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import type {
  EmailKeyedUser, EmailKeyedUserMatch, PrincipalResolution,
} from "@gadgets/workshop-shared/principal-resolver";
import {
  migrateToPrincipals, PRINCIPAL_MIGRATION_PATH, type AliasDirectory, type MigrationUsers,
} from "../src/auth/principal-aliases";
import server from "../src/server";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

vi.mock("jose", () => ({
  createRemoteJWKSet: () => () => undefined,
  jwtVerify: async (token: string) => ({
    payload: JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(token, { alphabet: "base64url" }))),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** An in-memory user directory with the real one's alias rules. */
function fakeDirectory(ids: string[]) {
  let aliases = new Map<string, string>();
  let writes = 0;
  let directory: AliasDirectory = {
    listUserIds: async () => ids.toSorted(),
    principalAlias: async principal => aliases.get(principal) ?? null,
    listPrincipalAliases: async () => [...aliases].map(([principal, user]) => ({ principal, user })),
    addPrincipalAlias: async (principal, user) => {
      let existing = [...aliases].filter(([p, u]) => p === principal || u === user);
      if (existing.length === 0) {
        writes++;
        aliases.set(principal, user);
        return "added";
      }
      return existing.length === 1 && existing[0]![0] === principal && existing[0]![1] === user
        ? "already-aliased" : "conflict";
    },
  };
  return { directory, aliases, writes: () => writes };
}

function fakeUsers(threads: Record<string, number>): MigrationUsers {
  return {
    workshopUserId: name => [...new TextEncoder().encode(name)].map(b => b.toString(16)).join("").slice(0, 64),
    threadCount: async name => threads[name] ?? 0,
    accountExists: async name => name in threads,
  };
}

function matcher(byEmail: Record<string, EmailKeyedUserMatch["outcome"] | string>) {
  return {
    matchEmailKeyedUsers: vi.fn(async (users: EmailKeyedUser[]): Promise<EmailKeyedUserMatch[]> =>
      users.map(({ email }) => {
        let match = byEmail[email] ?? "unmatched";
        return match.startsWith("prn_")
          ? { email, outcome: "exact-single", principalId: match }
          : { email, outcome: match as "ambiguous" | "cross-district" | "unmatched" };
      })),
  };
}

const IDS = [
  "ada@district.example", "grace@district.example", "family@district.example",
  "stranger@elsewhere.example", "password_user", "principal:prn_existing",
];
const MATCHES = {
  "ada@district.example": "prn_ada",
  "grace@district.example": "prn_grace",
  "family@district.example": "ambiguous",
};
const THREADS = {
  "ada@district.example": 3, "grace@district.example": 0, "family@district.example": 2,
  "stranger@elsewhere.example": 1, "password_user": 4, "principal:prn_existing": 1,
};

describe("migrateToPrincipals", () => {
  it("dry-runs: reports counts and the mapping, and writes nothing", async () => {
    let { directory, writes } = fakeDirectory(IDS);
    let match = matcher(MATCHES);
    let report = await migrateToPrincipals({ directory, matcher: match, users: fakeUsers(THREADS), apply: false });

    // Only email-keyed users are planned: not password usernames, not principals.
    expect(match.matchEmailKeyedUsers.mock.calls[0]![0].map(u => u.email)).toEqual([
      "ada@district.example", "family@district.example", "grace@district.example", "stranger@elsewhere.example",
    ]);
    expect(report).toMatchObject({
      applied: false, users: 4, threads: 6,
      counts: { "alias": 2, "already-aliased": 0, "ambiguous": 1, "cross-district": 0, "unmatched": 1, "conflict": 0 },
    });
    expect(report.entries).toEqual([
      { user: "ada@district.example", outcome: "alias", threads: 3, principalId: "prn_ada" },
      { user: "family@district.example", outcome: "ambiguous", threads: 2 },
      { user: "grace@district.example", outcome: "alias", threads: 0, principalId: "prn_grace" },
      { user: "stranger@elsewhere.example", outcome: "unmatched", threads: 1 },
    ]);
    expect(writes()).toBe(0);
  });

  it("applies once, and a second run changes nothing", async () => {
    let { directory, aliases, writes } = fakeDirectory(IDS);
    let options = { directory, matcher: matcher(MATCHES), users: fakeUsers(THREADS), apply: true };

    let first = await migrateToPrincipals(options);
    expect(first.counts).toMatchObject({ "alias": 2, "already-aliased": 0 });
    expect(first.entries[0]).toEqual({
      user: "ada@district.example", outcome: "alias", threads: 3, principalId: "prn_ada", threadsViaPrincipal: 3,
    });
    expect([...aliases]).toEqual([
      ["principal:prn_ada", "ada@district.example"], ["principal:prn_grace", "grace@district.example"],
    ]);

    let second = await migrateToPrincipals(options);
    expect(second.counts).toMatchObject({ "alias": 0, "already-aliased": 2, "conflict": 0 });
    expect(second.entries.filter(e => e.outcome === "already-aliased").map(e => e.threadsViaPrincipal))
        .toEqual([3, 0]);
    expect(writes()).toBe(2);
  });

  it("never hides a principal's own account or aliases anyone twice", async () => {
    let { directory, aliases } = fakeDirectory([...IDS, "dup@district.example"]);
    await directory.addPrincipalAlias("principal:prn_grace", "someone-else@district.example");
    let report = await migrateToPrincipals({
      directory,
      matcher: matcher({ ...MATCHES, "ada@district.example": "prn_existing", "dup@district.example": "prn_dup",
        "stranger@elsewhere.example": "prn_dup" }),
      users: fakeUsers(THREADS),
      apply: true,
    });
    expect(Object.fromEntries(report.entries.map(e => [e.user, [e.outcome, e.reason]]))).toEqual({
      "ada@district.example": ["conflict", "principal-account-exists"],
      "dup@district.example": ["conflict", "principal-matched-twice"],
      "family@district.example": ["ambiguous", undefined],
      "grace@district.example": ["conflict", "principal-aliased-to-another-user"],
      "stranger@elsewhere.example": ["conflict", "principal-matched-twice"],
    });
    expect(aliases.size).toBe(1);
  });
});

const ORIGIN = "https://workshop.example";
const ISS = "https://team.cloudflareaccess.example";

function jwt(claims: Record<string, unknown>): string {
  return new TextEncoder().encode(JSON.stringify({ iss: ISS, aud: "audience", exp: Math.floor(Date.now() / 1000) + 3600, ...claims }))
      .toBase64({ alphabet: "base64url", omitPadding: true });
}

function executionContext(): ExecutionContext {
  const ctx = createExecutionContext();
  const adminSettings = { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) };
  return {
    waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    passThroughOnException: () => {},
    props: ctx.props,
    exports: new Proxy(ctx.exports, {
      get: (target, key) => key === "AdminSettings" ? adminSettings : Reflect.get(target, key),
    }),
  } as unknown as ExecutionContext;
}

// Users unique to this run, so other suites' users in the shared directory do not matter.
const RUN = crypto.randomUUID().slice(0, 8);
const ADMIN = `admin-${RUN}@district.example`;
const TEACHER = `teacher-${RUN}@district.example`;
const SIBLING = `sibling-${RUN}@district.example`;

const SUBJECTS: Record<string, PrincipalResolution> = {
  [`sub-admin-${RUN}`]: { outcome: "resolved", principalId: `prn_admin-${RUN}`, displayName: "Admin" },
  [`sub-teacher-${RUN}`]: { outcome: "resolved", principalId: `prn_teacher-${RUN}`, displayName: "Teacher" },
  [`sub-new-${RUN}`]: { outcome: "resolved", principalId: `prn_new-${RUN}`, displayName: "Newcomer" },
};

/** The district, as the fake both bindings point at. */
const district = {
  resolveAccessSignIn: vi.fn(async ({ subject }: { subject: string }): Promise<PrincipalResolution> =>
    SUBJECTS[subject] ?? { outcome: "unauthenticated" }),
  matchEmailKeyedUsers: async (users: EmailKeyedUser[]) => matcher({
    [ADMIN]: `prn_admin-${RUN}`, [TEACHER]: `prn_teacher-${RUN}`, [SIBLING]: "ambiguous",
  }).matchEmailKeyedUsers(users),
};

type Bindings = { migration?: boolean; resolver?: boolean };

function testEnv({ migration = false, resolver = false }: Bindings): Cloudflare.Env {
  return {
    ...env,
    CF_ACCESS_AUD: "audience",
    CF_ACCESS_ISS: ISS,
    ADMINS: JSON.stringify([ADMIN]),
    BLUEPRINTS: { get: async () => null } as unknown as KVNamespace,
    ...(migration ? { PRINCIPAL_MIGRATION: district as unknown as Cloudflare.Env["PRINCIPAL_MIGRATION"] } : {}),
    ...(resolver ? { PRINCIPAL_RESOLVER: district as unknown as Cloudflare.Env["PRINCIPAL_RESOLVER"] } : {}),
  };
}

async function migrate(bindings: Bindings, token: string, body: unknown, origin = ORIGIN) {
  const response = await server.fetch(new Request(`${ORIGIN}/ai${PRINCIPAL_MIGRATION_PATH}`, {
    method: "POST",
    headers: { Origin: origin, "cf-access-jwt-assertion": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv(bindings), executionContext());
  return { status: response.status, text: await response.text() };
}

async function signInAs(bindings: Bindings, token: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    server.fetch(new Request(input, init), testEnv(bindings), executionContext()));
  const api = newHttpBatchRpcSession<PublicApi>(new Request(`${ORIGIN}/api`, {
    headers: { Origin: ORIGIN, "cf-access-jwt-assertion": token },
  }));
  const me = await api.authenticateFromCfAccess().whoami();
  vi.restoreAllMocks();
  return me;
}

/** An email-keyed user, as sign-in created it before the cutover, with `threads` workspaces. */
async function legacyUser(email: string, threads: number) {
  const user = env.TEST_USER.getByName(email);
  await user.authenticateFromCfAccess(email, true);
  for (let i = 0; i < threads; i++) {
    await user.newWorkspace(`gadget-${RUN}-${email}-${i}`, `Thread ${i}`);
    await user.setWorkspaceLastActive(`gadget-${RUN}-${email}-${i}`, new Date(), undefined);
  }
  // The DO mirrors its profile into the directory in the background; record it directly too.
  await env.TEST_USER_DIRECTORY.getByName("").syncUser({ id: email, name: email.split("@")[0]! }, 1);
}

const mine = (report: { entries: { user: string }[] }) =>
  report.entries.filter(e => [ADMIN, TEACHER, SIBLING].includes(e.user));

describe("the principal migration route", () => {
  it("is Not Found until a district is bound, so production is unchanged", async () => {
    expect((await migrate({}, jwt({ sub: `sub-admin-${RUN}`, email: ADMIN }), { apply: false })).status)
        .toBe(404);
  });

  it("migrates, idempotently, so existing users keep their threads under their principal", async () => {
    await legacyUser(ADMIN, 1);
    await legacyUser(TEACHER, 2);
    await legacyUser(SIBLING, 1);
    const adminEmailSignIn = jwt({ sub: `sub-admin-${RUN}`, email: ADMIN });

    // Before the cutover: PRINCIPAL_MIGRATION bound, sign-in still by email.
    expect(await migrate({ migration: true }, jwt({ sub: `sub-teacher-${RUN}`, email: TEACHER }), { apply: false }))
        .toEqual({ status: 403, text: "Only a Workshop administrator can run the principal migration." });
    expect((await migrate({ migration: true }, adminEmailSignIn, { apply: false }, "https://evil.example")).status)
        .toBe(403);
    expect((await migrate({ migration: true }, adminEmailSignIn, { apply: "yes" })).status).toBe(400);

    const dryRun = JSON.parse((await migrate({ migration: true }, adminEmailSignIn, { apply: false })).text);
    expect(dryRun.applied).toBe(false);
    expect(mine(dryRun)).toEqual([
      { user: ADMIN, outcome: "alias", threads: 1, principalId: `prn_admin-${RUN}` },
      { user: SIBLING, outcome: "ambiguous", threads: 1 },
      { user: TEACHER, outcome: "alias", threads: 2, principalId: `prn_teacher-${RUN}` },
    ]);
    // The dry run wrote nothing.
    await expect(env.TEST_USER_DIRECTORY.getByName("").principalAlias(`principal:prn_teacher-${RUN}`))
        .resolves.toBeNull();

    const applied = JSON.parse((await migrate({ migration: true }, adminEmailSignIn, { apply: true })).text);
    expect(mine(applied).map(e => [e.user, e.outcome, e.threads, e.threadsViaPrincipal])).toEqual([
      [ADMIN, "alias", 1, 1], [SIBLING, "ambiguous", 1, undefined], [TEACHER, "alias", 2, 2],
    ]);
    const again = JSON.parse((await migrate({ migration: true }, adminEmailSignIn, { apply: true })).text);
    expect(mine(again).map(e => e.outcome)).toEqual(["already-aliased", "ambiguous", "already-aliased"]);

    // After the cutover: PRINCIPAL_RESOLVER bound. The teacher's principal reaches the existing
    // account, threads and all, and its DO keeps the email name; the old DO is untouched.
    const teacher = await signInAs({ resolver: true }, jwt({ sub: `sub-teacher-${RUN}`, email: TEACHER }));
    expect(teacher.id).toBe(TEACHER);
    await expect(env.TEST_USER.getByName(TEACHER).listWorkspaces()).resolves.toHaveLength(2);
    await expect(env.TEST_USER.getByName(`principal:prn_teacher-${RUN}`).whoamiIfExists()).resolves.toBeNull();
    // A principal nobody aliased gets a fresh principal-named account.
    expect((await signInAs({ resolver: true }, jwt({ sub: `sub-new-${RUN}` }))).id).toBe(`principal:prn_new-${RUN}`);

    // The aliased admin is still an admin (ADMINS names its DO, which kept the email), and running
    // the migration again with only the resolver bound changes nothing.
    const afterCutover = await migrate({ resolver: true }, jwt({ sub: `sub-admin-${RUN}` }), { apply: true });
    expect(afterCutover.status).toBe(200);
    expect(mine(JSON.parse(afterCutover.text)).map(e => e.outcome))
        .toEqual(["already-aliased", "ambiguous", "already-aliased"]);
  });

  it("answers a district that cannot be reached with 503 and a clear message", async () => {
    district.resolveAccessSignIn.mockRejectedValueOnce(new Error("district down"));
    const response = await migrate({ resolver: true }, jwt({ sub: `sub-admin-${RUN}` }), { apply: false });
    expect(response.status).toBe(503);
    expect(response.text).toContain("can't be reached");
  });
});
