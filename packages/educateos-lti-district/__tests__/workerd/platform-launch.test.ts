// The LTI Platform's launch state (SCHO-179) over `DurableObjectRecordTable`, in workerd, against
// real Durable Object SQLite storage: a launch ticket is redeemed by exactly one of many racing
// authentication requests and never again, survives a restart until it expires, and each person's
// per-tool subject is made once, however many launches race for it, and kept across restarts.

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LAUNCH_TICKET } from "./worker.ts";

let objects = 0;
const fresh = () => env.LTI.getByName(`platform-launch-${objects++}`);
const NOTEBOOK = "ltt_notebook00000000000000";
const QUIZ = "ltt_quizgarden000000000000";

describe("the LTI Platform's launch state in a Durable Object", () => {
  it("redeems a launch ticket for exactly one of 50 concurrent authentication requests, and never again", async () => {
    const district = fresh();
    await district.putLaunchTicket("hint-1", 60_000);
    const taken = await Promise.all(Array.from({ length: 50 }, () => district.takeLaunchTicket("hint-1")));
    expect(taken.filter((ticket) => ticket !== undefined)).toEqual([LAUNCH_TICKET]);
    await evictDurableObject(district);
    expect(await district.takeLaunchTicket("hint-1")).toBeUndefined();
  });

  it("keeps an unredeemed ticket across a restart, and refuses it once expired", async () => {
    const district = fresh();
    await district.putLaunchTicket("kept", 60_000);
    await district.putLaunchTicket("expired", -1);
    await evictDurableObject(district);
    expect(await district.takeLaunchTicket("kept")).toEqual(LAUNCH_TICKET);
    expect(await district.takeLaunchTicket("expired")).toBeUndefined();
  });

  it("makes one subject per person and tool under concurrent launches, and keeps it across restarts", async () => {
    const district = fresh();
    const subjects = await Promise.all(Array.from({ length: 20 }, () => district.subjectFor(NOTEBOOK)));
    expect(new Set(subjects).size).toBe(1);
    const [subject] = subjects;
    await evictDurableObject(district);
    expect(await district.subjectFor(NOTEBOOK)).toBe(subject);
    expect(await district.principalFor(NOTEBOOK, subject!)).toBe("prn_nf-student-amara");
    // Another tool gets its own subject, and cannot look up the first tool's.
    expect(await district.subjectFor(QUIZ)).not.toBe(subject);
    expect(await district.principalFor(QUIZ, subject!)).toBeUndefined();
  });
});
