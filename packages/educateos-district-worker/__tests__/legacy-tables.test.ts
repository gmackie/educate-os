// The district's recovery of the tables the rename orphaned (SCHO-232), against real Durable Object
// SQLite storage. Each test builds the state production was left in: the district's rows from
// before the rename in `schoolos_*` tables, made with the old DDL, and rows written since in the new (rename-educateos: keep)
// `educateos_*` tables, without the migration having run. Then the stores start, as a deploy of
// this code would start them, and every row of both sides must be readable.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES, routePath, type RouteName } from "@educateos/district-app/routes";
import {
  DurableObjectAnnouncementStore,
  DurableObjectCourseContentStorage,
  DurableObjectDiscussionStorage,
  DurableObjectFundingAllocationStore,
  DurableObjectGradebookStore,
  DurableObjectGuardianRelationshipStore,
  DurableObjectQuizStorage,
  DurableObjectToolApprovalStore,
  DurableObjectWeeklyNoteStore,
  durableDistrictStores,
} from "@educateos/district-app/durable-stores";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

type Storage = DurableObjectStorage;
type Stub = ReturnType<typeof env.DISTRICT.getByName>;

let objects = 0;
const fresh = () => env.DISTRICT.getByName(`legacy-${objects++}`);

/** Every `educateos_*` table of `storage`: its DDL (tables first) and its rows with their rowids. */
interface Dump {
  schema: { type: string; name: string; sql: string }[];
  rows: Record<string, Record<string, unknown>[]>;
}

function dump(storage: Storage): Dump {
  const schema = storage.sql.exec(
    `SELECT type, name, sql FROM sqlite_master WHERE tbl_name LIKE 'educateos\\_%' ESCAPE '\\' AND sql IS NOT NULL
     ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid`,
  ).toArray() as Dump["schema"];
  const rows: Dump["rows"] = {};
  for (const { name } of schema.filter((s) => s.type === "table")) {
    rows[name] = storage.sql.exec(`SELECT rowid AS rowid_, * FROM ${name} ORDER BY rowid`).toArray();
  }
  return { schema, rows };
}

/** Creates `dump`'s tables in `storage` under `rename`'s names, rows and rowids as they were. */
function restore(storage: Storage, { schema, rows }: Dump, rename: (text: string) => string = (text) => text): void {
  for (const { type, sql } of schema) if (type === "table") storage.sql.exec(rename(sql));
  for (const [table, list] of Object.entries(rows)) {
    const aliased = storage.sql.exec(`PRAGMA table_info(${rename(table)})`).toArray().some((c) => c.pk === 1 && String(c.type).toUpperCase() === "INTEGER");
    for (const { rowid_, ...row } of list) {
      const columns = [...(aliased ? [] : ["rowid"]), ...Object.keys(row)];
      const values = [...(aliased ? [] : [rowid_]), ...Object.values(row)] as (string | number | null | ArrayBuffer)[];
      storage.sql.exec(`INSERT INTO ${rename(table)} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...values);
    }
  }
  for (const { type, sql } of schema) if (type !== "table") storage.sql.exec(rename(sql));
}

/** The DDL the rename rewrote: every name and message, as the code before it wrote them. */
const asLegacy = (text: string) => text.replaceAll("educateos_", "schoolos_"); // rename-educateos: keep

const tablesOf = (storage: Storage, pattern: string) =>
  storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\' ORDER BY name", pattern).toArray().map((r) => String(r.name));

/**
 * Leaves `target` as production was left: `before` writes through the stores in one object, whose
 * tables become the legacy tables; `since` writes through them in another, whose tables are the
 * current ones. The target object is then evicted, so the next stores to open it are new instances.
 */
async function renamedDistrict(target: Stub, before: (storage: Storage) => Promise<void>, since: (storage: Storage) => Promise<void> = async () => {}): Promise<void> {
  const legacy = await runInDurableObject(fresh(), async (_instance, state) => {
    await before(state.storage);
    return dump(state.storage);
  });
  const current = await runInDurableObject(fresh(), async (_instance, state) => {
    await since(state.storage);
    return dump(state.storage);
  });
  await runInDurableObject(target, async (_instance, state) => {
    restore(state.storage, legacy, asLegacy);
    restore(state.storage, current);
  });
  await evictDurableObject(target);
}

const at = "2026-10-23T12:00:00.000Z";
const BIO = "off_nf-bio-fall-p2" as never;
const ENG9 = "off_nf-eng9-fall-p3" as never;

const outline = (offeringId: string, revision: number, modules: [string, string][], pages: [string, string][]) => ({
  offeringId,
  revision,
  modules: modules.map(([id, title]) => ({ id, title, published: true, items: [] })),
  pages: pages.map(([id, title]) => ({ id, title, body: `# ${title}` })),
  updated: { by: "prn_nf-morgan-lee", at },
}) as never;

const topic = (offeringId: string, id: string, title: string) => ({
  id, offeringId, title, prompt: "Argue **one** side.", locked: false, pinned: false, settings: { allowReplies: true },
  createdBy: "prn_nf-morgan-lee", createdAt: at, updatedAt: at,
});
const post = (offeringId: string, id: string, topicId: string, body: string) => ({
  id, offeringId, topicId, authorId: "prn_nf-student-amara", authorRole: "student", body, status: "visible", flags: [], createdAt: at,
});
const boardWrite = (revision: number, parts: Record<string, unknown>) =>
  ({ revision, settings: { premoderation: false }, topics: [], deletedTopicIds: [], posts: [], moderation: [], ...parts }) as never;

const quiz = (offeringId: string, id: string, title: string, status = "draft") => ({
  id, offeringId, title, description: "", status,
  items: [{ id: "qzi_tf", type: "true-false", prompt: "Viruses are cells.", points: 1, correct: false }],
  settings: { attemptsAllowed: 2, shuffleQuestions: true, shuffleChoices: false, showAnswers: "after-release", scorePolicy: "best" },
  createdBy: "prn_nf-morgan-lee", createdAt: at, updatedAt: at,
});
const attempt = (offeringId: string, id: string, quizId: string) => ({
  id, quizId, offeringId, studentId: "prn_nf-student-amara", number: 1, seed: "0123456789abcdef", startedAt: at, answers: [], status: "in-progress",
});
const quizRelease = (id: string, quizId: string) => ({ id, quizId, by: "prn_nf-morgan-lee", at, grades: [] });
const quizWrite = (revision: number, parts: Record<string, unknown>) =>
  ({ revision, quizzes: [], deletedQuizIds: [], attempts: [], releases: [], ...parts }) as never;

const relationship = (id: string, guardian: string, status: "pending" | "active") => ({
  id,
  districtId: "dst_northfield",
  guardianPrincipalId: guardian,
  studentPrincipalId: "prn_nf-student-amara",
  status,
  readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
  consent: "not-required",
  validFrom: at,
  created: { by: "prn_nf-district-admin", at },
  ...(status === "active" ? { confirmed: { by: "prn_nf-district-admin", at } } : {}),
}) as never;
const relationshipEvent = (id: string, guardian: string, change: string) => ({
  districtId: "dst_northfield",
  actor: { principalId: "prn_nf-district-admin" },
  action: `guardian-relationship.${change}`,
  target: { relationshipId: id, guardianPrincipalId: guardian, studentPrincipalId: "prn_nf-student-amara" },
  at,
}) as never;

const funding = (id: string, number: number, previousRevisionId?: string) => ({
  id, number, allocations: { fpl_courses: "1000" }, actorPrincipalId: "prn_nf-district-admin", appliedAt: at,
  ...(previousRevisionId === undefined ? {} : { previousRevisionId }),
}) as never;

const announcement = (id: string, title: string) => ({
  id, districtId: "dst_northfield", offeringId: ENG9, title, body: "Bring your field notebook.", publishAt: at, created: { by: "prn_nf-teacher-rivera", at },
}) as never;

const gradebookSettings = (weight: number) => ({
  weighting: "group-weights", calculation: "points", missing: "zero",
  groups: [{ id: "grp_labs", name: "Labs", weight, dropLowest: 0, assignmentIds: ["asg_lab-1"] }],
  scale: [{ letter: "A", minPercent: 90 }, { letter: "F", minPercent: 0 }],
}) as never;

const action = (id: string, idempotencyKey: string) => ({
  id, tool: "create_term", input: { name: "Spring 2027" }, subject: { principalId: "prn_nf-district-admin", districtId: "dst_northfield" },
  channel: "agent", correlationId: "corr-1", needs: "confirmation", idempotencyKey, createdAt: at, expiresAt: "2026-10-29T12:00:00.000Z", state: "pending",
}) as never;

/** The district's content from before the rename: what the co-op wrote. */
async function writtenBeforeTheRename(storage: Storage): Promise<void> {
  const course = new DurableObjectCourseContentStorage(storage);
  await course.commit(outline(BIO, 1, [["cmod_rocks", "Unit 1: Rocks and Minerals"]], []), 0);
  await course.commit(outline(BIO, 2, [["cmod_rocks", "Unit 1: Rocks and Minerals"]], [["cpg_rocks", "Rock cycle"]]), 1);
  await course.commit(outline(ENG9, 1, [["cmod_poems", "Poetry"]], []), 0);

  const board = new DurableObjectDiscussionStorage(storage);
  await board.commit(BIO, boardWrite(1, {
    topics: [topic(BIO, "dtp_rocks", "Which rock is oldest?")],
    posts: [post(BIO, "dps_1", "dtp_rocks", "Granite"), post(BIO, "dps_2", "dtp_rocks", "Basalt")],
    moderation: [{ id: "dme_1", action: "pin", by: "prn_nf-morgan-lee", at }],
  }), 0);

  const quizzes = new DurableObjectQuizStorage(storage);
  await quizzes.commit(BIO, quizWrite(1, { quizzes: [quiz(BIO, "qz_0d44bf2e", "Minerals check")] }), 0);
  await quizzes.commit(BIO, quizWrite(2, { releases: [quizRelease("qzr_old", "qz_0d44bf2e")] }), 1);

  const guardians = new DurableObjectGuardianRelationshipStore(storage);
  await guardians.commit(relationship("grl_gale-amara", "prn_nf-guardian-gale", "pending"), relationshipEvent("grl_gale-amara", "prn_nf-guardian-gale", "recorded"), undefined);
  await guardians.commit(relationship("grl_gale-amara", "prn_nf-guardian-gale", "active"), relationshipEvent("grl_gale-amara", "prn_nf-guardian-gale", "confirmed"), relationship("grl_gale-amara", "prn_nf-guardian-gale", "pending"));
  await guardians.commit(relationship("grl_gina-amara", "prn_nf-guardian-gina", "active"), relationshipEvent("grl_gina-amara", "prn_nf-guardian-gina", "recorded"), undefined);

  const settings = new DurableObjectFundingAllocationStore(storage);
  await settings.append(funding("far_one", 1), undefined);
  await settings.append(funding("far_two", 2, "far_one"), "far_one");

  await new DurableObjectAnnouncementStore(storage).put(announcement("ann_field-trip", "Field trip Friday"));
  await new DurableObjectWeeklyNoteStore(storage).put({ offeringId: ENG9, week: "2026-W43", text: "We read Frost.", updated: { by: "prn_nf-teacher-rivera", at } } as never);
  await new DurableObjectGradebookStore(storage).saveSettings(BIO, gradebookSettings(60), { by: "prn_nf-morgan-lee", at } as never, 0);
  await new DurableObjectToolApprovalStore(storage).insertUnlessOpen(action("apr_old", "a".repeat(64)));
}

/** What the district wrote since the rename's first deploy, into the new, empty tables. */
async function writtenSince(storage: Storage): Promise<void> {
  await new DurableObjectCourseContentStorage(storage).commit(outline(BIO, 1, [["cmod_new", "Unit 2: Fossils"]], [["cpg_new", "Fossil hunt"]]), 0);
  await new DurableObjectQuizStorage(storage).commit(BIO, quizWrite(1, {
    quizzes: [quiz(BIO, "qz_b435127a", "Fossils quiz", "published")],
    attempts: [attempt(BIO, "qza_new", "qz_b435127a")],
    releases: [quizRelease("qzr_new", "qz_b435127a")],
  }), 0);
  // Gale's relationship, re-created because the old one seemed lost.
  const guardians = new DurableObjectGuardianRelationshipStore(storage);
  await guardians.commit(relationship("grl_gale-again", "prn_nf-guardian-gale", "active"), relationshipEvent("grl_gale-again", "prn_nf-guardian-gale", "recorded"), undefined);
  await new DurableObjectFundingAllocationStore(storage).append(funding("far_three", 1), undefined);
  await new DurableObjectGradebookStore(storage).saveSettings(BIO, gradebookSettings(80), { by: "prn_nf-morgan-lee", at } as never, 0);
  await new DurableObjectToolApprovalStore(storage).insertUnlessOpen(action("apr_new", "b".repeat(64)));
}

describe("the district's stores after the rename (SCHO-232)", () => {
  it("show every row of both sides, settle each conflict by its rule, keep the legacy tables as backups, and migrate once", async () => {
    const object = fresh();
    await renamedDistrict(object, writtenBeforeTheRename, writtenSince);

    const read = async (storage: Storage) => {
      const course = new DurableObjectCourseContentStorage(storage);
      const guardians = new DurableObjectGuardianRelationshipStore(storage);
      return {
        bio: await course.load(BIO),
        eng9: await course.load(ENG9),
        board: await new DurableObjectDiscussionStorage(storage).load(BIO),
        quizzes: await new DurableObjectQuizStorage(storage).load(BIO),
        gale: (await guardians.listForGuardian("prn_nf-guardian-gale" as never)).map((r) => r.id),
        gina: (await guardians.listForGuardian("prn_nf-guardian-gina" as never)).map((r) => r.id),
        galeHistory: (await guardians.history("grl_gale-amara" as never)).map((e) => e.action),
        funding: (await new DurableObjectFundingAllocationStore(storage).list()).map((r) => r.id),
        announcements: (await new DurableObjectAnnouncementStore(storage).list(ENG9)).map((a) => a.title),
        note: (await new DurableObjectWeeklyNoteStore(storage).get(ENG9, "2026-W43" as never))?.text,
        gradebook: await new DurableObjectGradebookStore(storage).load(BIO),
        approvals: (await new DurableObjectToolApprovalStore(storage).list()).map((a) => a.id),
      };
    };

    const first = await runInDurableObject(object, async (_instance, state) => read(state.storage));
    // Course content: the legacy modules and pages first, the ones added since after them, under a
    // revision past both, so an edit planned against either side is planned again.
    expect(first.bio?.modules.map((m) => m.title)).toStrictEqual(["Unit 1: Rocks and Minerals", "Unit 2: Fossils"]);
    expect(first.bio?.pages.map((p) => p.id)).toStrictEqual(["cpg_rocks", "cpg_new"]);
    expect(first.bio?.revision).toBe(3);
    expect(first.eng9?.modules.map((m) => m.title)).toStrictEqual(["Poetry"]);
    // The discussion with its two posts and its moderation trail.
    expect(first.board?.topics.map((t) => t.title)).toStrictEqual(["Which rock is oldest?"]);
    expect(first.board?.posts.map((p) => p.body)).toStrictEqual(["Granite", "Basalt"]);
    expect(first.board?.moderation.map((m) => m.id)).toStrictEqual(["dme_1"]);
    // The draft quiz, the quiz made since with its attempt, and both releases in order.
    expect(first.quizzes?.quizzes.map((q) => [q.id, q.status])).toStrictEqual([["qz_0d44bf2e", "draft"], ["qz_b435127a", "published"]]);
    expect(first.quizzes?.attempts.map((a) => a.id)).toStrictEqual(["qza_new"]);
    expect(first.quizzes?.releases.map((r) => r.id)).toStrictEqual(["qzr_old", "qzr_new"]);
    expect(first.quizzes?.revision).toBe(3);
    // Gale has one open relationship, the one in use; the legacy one's history is kept.
    expect(first.gale).toStrictEqual(["grl_gale-again"]);
    expect(first.gina).toStrictEqual(["grl_gina-amara"]);
    expect(first.galeHistory).toStrictEqual(["guardian-relationship.recorded", "guardian-relationship.confirmed"]);
    // The settings history, oldest first, its head the revision applied since.
    expect(first.funding).toStrictEqual(["far_one", "far_two", "far_three"]);
    expect(first.announcements).toStrictEqual(["Field trip Friday"]);
    expect(first.note).toBe("We read Frost.");
    // The gradebook settings saved since win, under a revision past both.
    expect(first.gradebook).toMatchObject({ revision: 2, settings: { groups: [{ weight: 80 }] } });
    expect(first.approvals).toStrictEqual(["apr_old", "apr_new"]);

    await runInDurableObject(object, async (_instance, state) => {
      // Every legacy table is kept, renamed; none is left under its legacy name.
      const backups = tablesOf(state.storage, "schoolos\\_%"); // rename-educateos: keep
      expect(backups.every((name) => name.endsWith("_premigration"))).toBe(true);
      expect(backups).toContain("schoolos_quizzes_premigration"); // rename-educateos: keep
      expect(backups).toContain("schoolos_district_funding_revisions_premigration"); // rename-educateos: keep
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM schoolos_guardian_relationships_premigration").one().n).toBe(2); // rename-educateos: keep
      // The merged rows take writes as usual: the next edit is planned over the merged revision.
      await expect(new DurableObjectQuizStorage(state.storage).commit(BIO, quizWrite(2, {}), 1)).rejects.toMatchObject({ code: "conflict" });
      await new DurableObjectQuizStorage(state.storage).commit(BIO, quizWrite(4, { releases: [quizRelease("qzr_next", "qz_b435127a")] }), 3);
      await new DurableObjectFundingAllocationStore(state.storage).append(funding("far_four", 2, "far_three"), "far_three");
    });

    // A second start finds nothing to migrate and reads the same district.
    await evictDurableObject(object);
    const second = await runInDurableObject(object, async (_instance, state) => {
      const result = await read(state.storage);
      return { result, backups: tablesOf(state.storage, "schoolos\\_%") }; // rename-educateos: keep
    });
    expect(second.result.quizzes?.releases.map((r) => r.id)).toStrictEqual(["qzr_old", "qzr_new", "qzr_next"]);
    expect(second.result.funding).toStrictEqual(["far_one", "far_two", "far_three", "far_four"]);
    expect({ ...second.result, quizzes: undefined, funding: undefined }).toStrictEqual({ ...first, quizzes: undefined, funding: undefined });
    expect(second.backups.every((name) => name.endsWith("_premigration"))).toBe(true);
  });

  it("copies everything when nothing was written since, so all of a store's legacy rows reappear", async () => {
    const object = fresh();
    await renamedDistrict(object, writtenBeforeTheRename);
    const quizzes = await runInDurableObject(object, async (_instance, state) => new DurableObjectQuizStorage(state.storage).load(BIO));
    expect(quizzes).toMatchObject({ revision: 2, quizzes: [{ id: "qz_0d44bf2e" }], releases: [{ id: "qzr_old" }] });
  });

  it("merges the one-document stores: assessment records, the workspace directory and the artifact records", async () => {
    const object = fresh();
    const assignment = (id: string) => ({
      id, districtId: "dst_northfield", offeringId: BIO, activityId: "act_bio", title: `Lab ${id}`, dueAt: at, latePolicy: { kind: "accept" }, attemptsAllowed: 1,
      permittedArtifactTypes: ["document"], feedbackVisibility: "when-shared", createdBy: "prn_nf-morgan-lee", createdAt: at, updatedAt: at,
    });
    const personal = (id: string, owner: string) => ({ id, kind: "personal", districtId: "dst_northfield", ownerPrincipalId: owner, createdAt: at });
    const records = (artifact: string) => ({
      artifacts: [], revisions: [], pins: [],
      shares: [{ artifactId: artifact, granteePrincipalId: "prn_nf-morgan-lee", grantedBy: "prn_nf-student-amara", grantedAt: at }],
    });
    // Written raw: these stores' states have many invariants, and the merge is what is under test.
    const seed = (assignments: object[], workspaces: object[], artifacts: object) => async (storage: Storage) => {
      const stores = durableDistrictStores(storage, NORTHFIELD);
      await stores.assessment.load();
      storage.sql.exec("INSERT INTO educateos_assessment_records (id, version, state_json) VALUES (1, 4, ?)",
        JSON.stringify({ assignments, starterMaterials: [], submissions: [], feedback: [], gradeProposals: [], gradeVersions: [] }));
      await stores.workspaces.load();
      for (const w of workspaces as { id: string; ownerPrincipalId: string }[]) {
        storage.sql.exec("INSERT INTO educateos_workspaces (id, kind, owner_principal_id, offering_id, workspace_json) VALUES (?, 'personal', ?, NULL, ?)", w.id, w.ownerPrincipalId, JSON.stringify(w));
      }
      storage.sql.exec("INSERT INTO educateos_workspace_state (id, version, state_json) VALUES (1, 2, ?)",
        JSON.stringify({ grants: [], closures: [], promotions: [], events: [], deletions: [] }));
      await stores.artifactRecords.load();
      storage.sql.exec("INSERT INTO educateos_artifact_records (id, version, parts) VALUES (1, 3, 1)");
      storage.sql.exec("INSERT INTO educateos_artifact_records_parts (part, data) VALUES (0, ?)", JSON.stringify(artifacts));
    };
    await renamedDistrict(
      object,
      seed([assignment("asg_old")], [personal("wsp_amara", "prn_nf-student-amara")], records("art_old")),
      seed([assignment("asg_new")], [personal("wsp_elena", "prn_nf-student-elena")], records("art_new")),
    );
    const merged = await runInDurableObject(object, async (_instance, state) => {
      const stores = durableDistrictStores(state.storage, NORTHFIELD);
      const assessment = await stores.assessment.load().catch((error: Error) => error.message);
      const workspaces = await stores.workspaces.load().catch((error: Error) => error.message);
      const artifacts = await stores.artifactRecords.load().catch((error: Error) => error.message);
      return { assessment, workspaces, artifacts };
    });
    expect(merged.assessment).toMatchObject({ version: 5, state: { assignments: [{ id: "asg_old" }, { id: "asg_new" }] } });
    expect(merged.workspaces).toMatchObject({ version: 3, state: { workspaces: [{ id: "wsp_amara" }, { id: "wsp_elena" }] } });
    expect(merged.artifacts).toMatchObject({ version: 4, state: { shares: [{ artifactId: "art_old" }, { artifactId: "art_new" }] } });
  });

  it("refuses to merge two workspaces with one key, and leaves both sides as they were", async () => {
    const object = fresh();
    const personal = (id: string) => ({ id, kind: "personal", districtId: "dst_northfield", ownerPrincipalId: "prn_nf-student-amara", createdAt: at });
    const seed = (id: string) => async (storage: Storage) => {
      await durableDistrictStores(storage, NORTHFIELD).workspaces.load();
      storage.sql.exec("INSERT INTO educateos_workspaces (id, kind, owner_principal_id, offering_id, workspace_json) VALUES (?, 'personal', 'prn_nf-student-amara', NULL, ?)", id, JSON.stringify(personal(id)));
    };
    await renamedDistrict(object, seed("wsp_before"), seed("wsp_since"));
    await runInDurableObject(object, async (_instance, state) => {
      await expect(durableDistrictStores(state.storage, NORTHFIELD).workspaces.load()).rejects.toThrow(/cannot be merged/);
      expect(tablesOf(state.storage, "schoolos\\_workspace%")).toStrictEqual(["schoolos_workspace_state", "schoolos_workspaces"]); // rename-educateos: keep
      expect(state.storage.sql.exec("SELECT id FROM educateos_workspaces").toArray()).toStrictEqual([{ id: "wsp_since" }]);
    });
  });

  it("starts every store of the district over the legacy tables at once", async () => {
    const object = fresh();
    await renamedDistrict(object, writtenBeforeTheRename, writtenSince);
    await runInDurableObject(object, async (_instance, state) => {
      const stores = durableDistrictStores(state.storage, NORTHFIELD);
      expect((await stores.quizzes.load(BIO))?.quizzes).toHaveLength(2);
      expect(await stores.config.list()).toStrictEqual([]);
    });
  });
});

// End to end, through the deployed Worker's `/api` surface: the co-op's district object as the
// rename left it, read by its teacher after this code starts.

async function signIn(principalId: string): Promise<string> {
  const principal = NORTHFIELD.principals.find((p) => p.id === principalId)!;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: principal.externalIdentities[0]!.subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

async function get(token: string, name: RouteName, params: Record<string, string>): Promise<unknown> {
  const response = await SELF.fetch(new Request(new URL(routePath(ROUTES[name].path, params), "https://district.example"), {
    headers: { "cf-access-jwt-assertion": token },
  }));
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  return ROUTES[name].response.parse(body);
}

describe("the district Worker after the rename (SCHO-232)", () => {
  it("serves the content stored before the rename beside what was written since", async () => {
    const district = env.DISTRICT.getByName(NORTHFIELD.district.id);
    await renamedDistrict(
      district,
      async (storage) => {
        await new DurableObjectAnnouncementStore(storage).put(announcement("ann_field-trip", "Field trip Friday"));
        await new DurableObjectDiscussionStorage(storage).commit(ENG9, boardWrite(1, {
          topics: [topic(ENG9, "dtp_frost", "The road not taken")],
          posts: [post(ENG9, "dps_a", "dtp_frost", "Choice"), post(ENG9, "dps_b", "dtp_frost", "Regret")],
        }), 0);
        await new DurableObjectQuizStorage(storage).commit(ENG9, quizWrite(1, { quizzes: [quiz(ENG9, "qz_0d44bf2e", "Poetry check")] }), 0);
      },
      async (storage) => {
        await new DurableObjectQuizStorage(storage).commit(ENG9, quizWrite(1, { quizzes: [quiz(ENG9, "qz_b435127a", "Frost quiz", "published")] }), 0);
      },
    );
    const rivera = await signIn("prn_nf-teacher-rivera");
    const announcements = await get(rivera, "teacher.listAnnouncements", { offeringId: ENG9 }) as { announcement: { title: string } }[];
    expect(announcements.map((a) => a.announcement.title)).toStrictEqual(["Field trip Friday"]);
    const discussions = await get(rivera, "teacher.listDiscussions", { offeringId: ENG9 }) as { topics: { topic: { title: string }; posts: number }[] };
    expect(discussions.topics.map((t) => [t.topic.title, t.posts])).toStrictEqual([["The road not taken", 2]]);
    const thread = await get(rivera, "teacher.discussionThread", { offeringId: ENG9, topicId: "dtp_frost" }) as { posts: unknown[] };
    expect(thread.posts).toHaveLength(2);
    const quizzes = await get(rivera, "teacher.listQuizzes", { offeringId: ENG9 }) as { quizzes: { quiz: { id: string } }[] };
    expect(quizzes.quizzes.map((q) => q.quiz.id).toSorted()).toStrictEqual(["qz_0d44bf2e", "qz_b435127a"]);
    await runInDurableObject(district, async (_instance, state) => {
      expect(tablesOf(state.storage, "schoolos\\_%").filter((name) => !name.endsWith("_premigration"))).toStrictEqual([]); // rename-educateos: keep
    });
  });
});
