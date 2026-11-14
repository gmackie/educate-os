// SCHO-390 in workerd: the rows SQLite reports read by ordinary person requests against the
// district's real SQLite Durable Object, in the style of notification-sweep.test.ts. Before
// SCHO-390 every policy decision and most service reads loaded the whole academic directory (every
// principal, enrollment, role assignment, offering, course, school and term); now a load reads the
// directory's one-row head and reuses the snapshot it parsed while the version has not moved.

import { env, runInDurableObject } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import type { DistrictObject } from "../src/district-object.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const NF = {
  admin: "prn_nf-district-admin",
  rivera: "prn_nf-teacher-rivera",
  amara: "prn_nf-student-amara",
  eng9: "off_nf-eng9-fall-p3",
} as const;

const eng9 = NORTHFIELD.offerings.find((o) => o.id === NF.eng9)!;
const eng9Scope = { level: "offering", districtId: eng9.districtId, schoolId: eng9.schoolId, offeringId: NF.eng9 } as const;

const { principals, enrollments, roleAssignments, offerings, courses, schools, terms } = NORTHFIELD;
/** Rows one full read of the directory's record tables costs. */
const DIRECTORY_ROWS = [principals, enrollments, roleAssignments, offerings, courses, schools, terms].reduce((sum, list) => sum + list.length, 0);

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** One request, with the rows its statements read: in all, and from the directory's tables. */
interface Measured {
  status: number;
  rowsRead: number;
  directoryRowsRead: number;
}

/** Serves `request` as `principalId` inside the district's object, counting every statement's rows. */
async function measure(stub: DurableObjectStub<DistrictObject>, principalId: string, path: string, init: RequestInit = {}): Promise<Measured> {
  const assertion = await signIn(principalId);
  return runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    const exec = sql.exec.bind(sql);
    const cursors: { query: string; cursor: { rowsRead: number } }[] = [];
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec(query, ...bindings);
      cursors.push({ query, cursor });
      return cursor;
    }) as typeof sql.exec;
    let status: number;
    try {
      const response = await instance.fetch(new Request(`https://district.example${path}`, {
        ...init,
        headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion, ...init.headers },
      }));
      status = response.status;
      await response.arrayBuffer();
    } finally {
      sql.exec = exec;
    }
    return {
      status,
      rowsRead: cursors.reduce((sum, c) => sum + c.cursor.rowsRead, 0),
      directoryRowsRead: cursors.filter((c) => /\bacademic_/.test(c.query)).reduce((sum, c) => sum + c.cursor.rowsRead, 0),
    };
  });
}

const requests = {
  "a teacher's gradebook": [NF.rivera, `/api/teacher/offerings/${NF.eng9}/gradebook`, {}],
  "a student's activity list": [NF.amara, `/api/student/offerings/${NF.eng9}/activities`, {}],
  "an administrator's policy explain": [NF.admin, "/api/admin/policy/simulate", {
    method: "POST",
    body: JSON.stringify({
      principalId: NF.rivera,
      action: "grade",
      resource: { kind: "official-grade", scope: eng9Scope, classification: "course", ownerPrincipalId: NF.amara },
      channel: "http",
      termState: "active",
    }),
  }],
} satisfies Record<string, [string, string, RequestInit]>;

describe("rows read by a person request", () => {
  it.each(Object.entries(requests))("%s reads the directory's head, not the whole directory", async (name, [principalId, path, init]) => {
    const stub = env.DISTRICT.getByName(`directory-reads-${name}`);
    // The first request boots the object and creates every store's tables; measure a warm one.
    const cold = await measure(stub, principalId, path, init);
    expect(cold.status, name).toBe(200);
    const warm = await measure(stub, principalId, path, init);
    expect(warm.status, name).toBe(200);
    console.log(`SCHO-390 rows read, ${name}: cold ${cold.rowsRead} (directory ${cold.directoryRowsRead}), warm ${warm.rowsRead} (directory ${warm.directoryRowsRead}); one directory read is ${DIRECTORY_ROWS} rows`);
    // Warm, no statement reads the directory's record tables (before SCHO-390, 1,062 to 1,326 rows
    // read here): each load is its one-row head.
    expect(warm.directoryRowsRead).toBeLessThan(DIRECTORY_ROWS);
    expect(warm.rowsRead).toBeLessThan(DIRECTORY_ROWS);
  });
});
