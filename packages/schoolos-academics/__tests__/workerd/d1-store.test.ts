// `D1AcademicStore` in workerd against a Miniflare D1 database migrated from `migrations/`: it
// round-trips a district, writes only changed rows, never lets a stale commit overwrite a newer
// one (even from another store instance), and refuses data it cannot trust.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PrincipalId, type DistrictDirectorySnapshot } from "@schoolos/contracts";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import {
  AcademicDirectory,
  D1AcademicStore,
  RoleTableAuthorizer,
  storePrincipalFacts,
  type D1DatabaseLike,
} from "../../src/index.ts";
import { ALL_LOCAL, NF, rejectsWith } from "../setup.ts";

const TABLES = [
  "academic_directory",
  "academic_schools",
  "academic_terms",
  "academic_courses",
  "academic_offerings",
  "academic_principals",
  "academic_enrollments",
  "academic_role_assignments",
];

beforeEach(async () => {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

/** The database, recording the SQL of every statement each batch runs. */
function recordingDb() {
  const batches: string[][] = [];
  const queries = new WeakMap<object, string>();
  const db: D1DatabaseLike = {
    prepare(query) {
      const statement = env.DB.prepare(query);
      queries.set(statement, query);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        queries.set(bound, query);
        return bound;
      };
      return statement;
    },
    async batch(statements) {
      batches.push(statements.map((s) => queries.get(s) ?? "?"));
      return env.DB.batch(statements as D1PreparedStatement[]);
    },
  };
  return { db, batches };
}

function directoryOver(store: D1AcademicStore) {
  return new AcademicDirectory({ store, authority: ALL_LOCAL, authorizer: new RoleTableAuthorizer(storePrincipalFacts(store)) });
}

const rowCount = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("D1AcademicStore", () => {
  it("round-trips a seeded district at version 0", async () => {
    const store = await D1AcademicStore.seed(env.DB, NORTHFIELD);
    expect(await store.load()).toStrictEqual({ version: 0, snapshot: NORTHFIELD });
    // A second instance, as another isolate would have, reads the same.
    expect(await new D1AcademicStore(env.DB).load()).toStrictEqual({ version: 0, snapshot: NORTHFIELD });
  });

  it("refuses a second seed and an inconsistent one, writing nothing", async () => {
    const broken: DistrictDirectorySnapshot = structuredClone(NORTHFIELD);
    broken.enrollments[0]!.principalId = PrincipalId.parse("prn_nobody");
    await rejectsWith(D1AcademicStore.seed(env.DB, broken), "validation-failed");
    expect(await rowCount("academic_directory")).toBe(0);

    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    await rejectsWith(D1AcademicStore.seed(env.DB, RIVERBEND), "conflict");
    expect((await new D1AcademicStore(env.DB).load()).snapshot).toStrictEqual(NORTHFIELD);
  });

  it("commits a directory change in one batch that writes only the changed row", async () => {
    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    const { db, batches } = recordingDb();
    const directory = directoryOver(new D1AcademicStore(db));
    const school = NORTHFIELD.schools[0]!;

    await directory.updateSchool(NF.admin, school.id, { name: "Northfield High School (renamed)" });
    // One commit batch: the version check and one row update, nothing else.
    expect(batches.at(-1)).toStrictEqual([
      "INSERT INTO academic_directory_commit (expected_version) VALUES (?)",
      "UPDATE academic_schools SET position = ?, record_json = ? WHERE id = ?",
    ]);

    const term = await directory.createTerm(NF.admin, { name: "Summer 2027", startsOn: "2027-06-01", endsOn: "2027-08-01" });
    expect(batches.at(-1)).toStrictEqual([
      "INSERT INTO academic_directory_commit (expected_version) VALUES (?)",
      "INSERT INTO academic_terms (id, position, record_json) VALUES (?, ?, ?)",
    ]);

    const { version, snapshot } = await new D1AcademicStore(env.DB).load();
    expect(version).toBe(2);
    expect(snapshot.schools[0]!.name).toBe("Northfield High School (renamed)");
    expect(snapshot.terms.at(-1)).toStrictEqual(term);
  });

  it("refuses a commit planned against a version another instance has since replaced, atomically", async () => {
    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    const first = new D1AcademicStore(env.DB);
    const second = new D1AcademicStore(env.DB);
    const fromFirst = await first.load();
    const fromSecond = await second.load();

    fromFirst.snapshot.schools[0]!.name = "First";
    await first.commit(fromFirst.snapshot, 0);

    // The second instance still believes version 0 is current, so its batch reaches the database,
    // where the version check aborts it before any of its writes land.
    fromSecond.snapshot.schools[0]!.name = "Second";
    fromSecond.snapshot.terms[0]!.name = "Also second";
    await rejectsWith(second.commit(fromSecond.snapshot, 0), "conflict");

    const stored = await new D1AcademicStore(env.DB).load();
    expect(stored.version).toBe(1);
    expect(stored.snapshot.schools[0]!.name).toBe("First");
    expect(stored.snapshot.terms).toStrictEqual(NORTHFIELD.terms);
  });

  it("loses no write when many instances commit at once: each either lands or is told to retry", async () => {
    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        directoryOver(new D1AcademicStore(env.DB)).createTerm(NF.admin, { name: `Term ${i}`, startsOn: "2027-06-01", endsOn: "2027-08-01" }),
      ),
    );
    const landed = outcomes.filter((o) => o.status === "fulfilled").length;
    expect(landed).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "conflict" });
    }
    const { version, snapshot } = await new D1AcademicStore(env.DB).load();
    expect(version).toBe(landed);
    expect(snapshot.terms).toHaveLength(NORTHFIELD.terms.length + landed);
  });

  it("deletes a removed record's row and keeps the remaining order", async () => {
    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    const store = new D1AcademicStore(env.DB);
    const { snapshot } = await store.load();
    const [, ...rest] = snapshot.roleAssignments;
    await store.commit({ ...snapshot, roleAssignments: rest }, 0);
    expect((await new D1AcademicStore(env.DB).load()).snapshot.roleAssignments).toStrictEqual(rest);
    expect(await rowCount("academic_role_assignments")).toBe(rest.length);
  });

  it("refuses a commit that changes the district, and a row edited into an invalid record", async () => {
    await D1AcademicStore.seed(env.DB, NORTHFIELD);
    const store = new D1AcademicStore(env.DB);
    const { snapshot } = await store.load();
    await rejectsWith(store.commit({ ...snapshot, district: RIVERBEND.district }, 0), "conflict");

    await env.DB.prepare("UPDATE academic_schools SET record_json = ? WHERE id = ?")
      .bind('{"id":"sch_x","note":"edited by hand"}', NORTHFIELD.schools[0]!.id)
      .run();
    await expect(new D1AcademicStore(env.DB).load()).rejects.toThrow(/unreadable at schools\.0/);
  });
});
