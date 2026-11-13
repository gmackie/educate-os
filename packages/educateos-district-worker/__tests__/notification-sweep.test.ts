// SCHO-370 in workerd: the hourly notification sweep against the district's real SQLite Durable
// Object, counting the rows SQLite reports each statement wrote. A sweep over a district where
// nothing changed writes nothing; a sweep that owes a student a notification records that
// student's reads in the audit trail before storing it, and no one else's.

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { POLICY_AUDIT_TABLE } from "@educateos/policy/durable-object-audit-sink";
import { NOTIFICATION_CRON } from "../src/schedule.ts";
import type { DistrictObject } from "../src/district-object.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const NF = { rivera: "prn_nf-teacher-rivera", eng9: "off_nf-eng9-fall-p3" } as const;
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

/** One sweep, with the rows its statements wrote and read, as SQLite counts them. */
interface Sweep {
  rowsWritten: number;
  rowsRead: number;
  /** The audit events the sweep appended: their principals. */
  audited: string[];
}

/** Runs the hourly sweep inside the district's object, counting every statement's rows. */
async function sweep(stub: DurableObjectStub<DistrictObject>): Promise<Sweep> {
  return runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    const exec = sql.exec.bind(sql);
    const cursors: { rowsWritten: number; rowsRead: number }[] = [];
    // The audit table is made by the first decision recorded, so it may not exist yet.
    const trail = () => exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", POLICY_AUDIT_TABLE).toArray().length > 0;
    const before = trail() ? Number(exec(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${POLICY_AUDIT_TABLE}`).one().seq) : 0;
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec(query, ...bindings);
      cursors.push(cursor);
      return cursor;
    }) as typeof sql.exec;
    try {
      await instance.runScheduled(NOTIFICATION_CRON);
    } finally {
      sql.exec = exec;
    }
    const audited = !trail() ? [] : exec(`SELECT event_json FROM ${POLICY_AUDIT_TABLE} WHERE seq > ? ORDER BY seq`, before).toArray()
      .map((row) => (JSON.parse(String(row.event_json)) as { principalId: string }).principalId);
    return {
      rowsWritten: cursors.reduce((sum, c) => sum + c.rowsWritten, 0),
      rowsRead: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
      audited,
    };
  });
}

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

const activeStudents = NORTHFIELD.principals.filter((p) => p.kind === "student" && p.status === "active");
const eng9Students = new Set(NORTHFIELD.enrollments
  .filter((e) => e.offeringId === NF.eng9 && e.role === "student" && e.status === "active")
  .map((e) => e.principalId as string));

describe("the hourly notification sweep", () => {
  it("writes no rows when nothing changed, warm or after a restart", async () => {
    const stub = env.DISTRICT.getByName("sweep-idle");
    await sweep(stub);
    const warm = await sweep(stub);
    expect(warm.rowsWritten).toBe(0);
    expect(warm.audited).toStrictEqual([]);
    // The directory is read a couple of times a sweep, not once for every student and decision.
    const { principals, enrollments, roleAssignments, offerings, courses, schools, terms } = NORTHFIELD;
    const directoryRows = [principals, enrollments, roleAssignments, offerings, courses, schools, terms].reduce((sum, list) => sum + list.length, 0);
    expect(warm.rowsRead).toBeLessThan(3 * directoryRows + 10 * activeStudents.length);
    await evictDurableObject(stub);
    const cold = await sweep(stub);
    expect(cold.rowsWritten).toBe(0);
    expect(cold.audited).toStrictEqual([]);
  });

  it("records only the reads of students it adds a notification for, then writes nothing again", async () => {
    await sweep(district());
    const posted = await SELF.fetch(new Request(`https://district.example/api/teacher/offerings/${NF.eng9}/announcements`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-jwt-assertion": await signIn(NF.rivera) },
      body: JSON.stringify({ title: "Field trip forms", body: "Due Friday." }),
    }));
    expect(posted.status, await posted.text()).toBe(201);

    const owed = await sweep(district());
    expect(owed.rowsWritten).toBeGreaterThan(0);
    expect(new Set(owed.audited)).toStrictEqual(eng9Students);
    expect((await sweep(district())).rowsWritten).toBe(0);
  });
});
