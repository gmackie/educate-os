// SCHO-189 in workerd: announcements, the calendar feed and notification email through the Worker's
// own handlers, surviving a restart of the district's object, and the communication stores against
// real Durable Object SQLite storage.

import { createExecutionContext, createScheduledController, env, evictDurableObject, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import type { PrincipalId } from "@educateos/contracts";
import { ROUTES, routePath, type RouteInput, type RouteName, type RouteResponse } from "@educateos/district-app/routes";
import {
  DurableObjectAnnouncementStore,
  DurableObjectCalendarFeedStore,
  DurableObjectDigestLedgerStore,
  DurableObjectNotificationStore,
  DurableObjectPreferenceStore,
  DurableObjectWeeklyNoteStore,
} from "@educateos/district-app/durable-stores";
import { DIGEST_CRON, jobForCron, NOTIFICATION_CRON } from "../src/schedule.ts";
import deployed from "../cloudflare.config.ts";
import worker from "./worker.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const NF = { rivera: "prn_nf-teacher-rivera", amara: "prn_nf-student-amara", eng9: "off_nf-eng9-fall-p3" } as const;
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);

async function signIn(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

async function ok<N extends RouteName>(token: string, name: N, input: RouteInput<N> = {} as RouteInput<N>): Promise<RouteResponse<N>> {
  const spec = ROUTES[name];
  const parts = input as { params?: Record<string, string>; body?: unknown };
  const response = await SELF.fetch(new Request(new URL(routePath(spec.path, parts.params), "https://district.example"), {
    method: spec.method,
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
    ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
  }));
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${name} failed with ${response.status}: ${JSON.stringify(body)}`);
  return ROUTES[name].response.parse(body) as RouteResponse<N>;
}

const feed = (path: string) => SELF.fetch(new Request(new URL(path, "https://district.example")));

describe("communication through the Worker", () => {
  it("posts and reads announcements, and serves a calendar feed that survives a restart until revoked", async () => {
    const rivera = await signIn(NF.rivera);
    const amara = await signIn(NF.amara);
    const posted = await ok(rivera, "teacher.createAnnouncement", { params: { offeringId: NF.eng9 }, body: { title: "Library visit", body: "Friday, period 3." } });
    expect((await ok(amara, "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).map((a) => a.announcement.id)).toContain(posted.announcement.id);

    const { path } = await ok(amara, "me.rotateCalendarFeed");
    const first = await feed(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    // Long lines are folded (RFC 5545 §3.1); unfold to read them.
    // Calendar clients key events by UID, so the UIDs keep the domain they had before the rename (SCHO-232).
    expect((await first.text()).replace(/\r\n /g, "")).toContain(`UID:announcement-${posted.announcement.id}@dst_northfield.schoolos\r\n`); // rename-educateos: keep

    await evictDurableObject(district());
    expect((await feed(path)).status).toBe(200);
    expect((await ok(amara, "student.courseAnnouncements", { params: { offeringId: NF.eng9 } })).map((a) => a.announcement.id)).toContain(posted.announcement.id);
    await ok(amara, "me.revokeCalendarFeed");
    expect((await feed(path)).status).toBe(404);
    // Only /api is served: a feed path elsewhere is not the district's.
    expect((await feed(path.replace("/api/", "/"))).status).toBe(404);
  });

  it("emails notifications from the hourly Cron Trigger through the Email Service binding, once", async () => {
    const rivera = await signIn(NF.rivera);
    await ok(rivera, "teacher.createAnnouncement", { params: { offeringId: NF.eng9 }, body: { title: "Bring a novel", body: "Any novel." } });
    const before = (await district().sentEmail()).length;
    // The Worker's own scheduled handler, as a Cron Trigger calls it.
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: NOTIFICATION_CRON }), env, Object.assign(ctx, { exports }));
    await waitOnExecutionContext(ctx);
    const sent = (await district().sentEmail()).slice(before);
    const mine = sent.filter((m) => m.subject === "New announcement in English 9 (Period 3): Bring a novel");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      to: "family.okafor@northfield.example",
      from: { name: "Northfield EducateOS", email: "educateos@northfield.example" },
      text: expect.stringContaining("https://learn.northfield.example"),
    });
    // A second run has nothing more to send; no guardian is related to anyone here, so the digest trigger sends nothing.
    await district().runScheduled(NOTIFICATION_CRON);
    await district().runScheduled(DIGEST_CRON);
    expect((await district().sentEmail()).slice(before)).toHaveLength(sent.length);
  });

  it("declares exactly the Cron Triggers its scheduled handler recognises", () => {
    const crons = (deployed.worker.triggers ?? []).map((t) => (t as { schedule: string }).schedule);
    expect(crons).toStrictEqual([NOTIFICATION_CRON, DIGEST_CRON]);
    expect(crons.map(jobForCron)).toStrictEqual(["notifications", "digest"]);
    expect(jobForCron("0 0 * * *")).toBeUndefined();
  });
});

let objects = 0;
const fresh = () => env.DISTRICT.getByName(`communication-${objects++}`);
const AT = "2026-10-25T14:00:00.000Z";

describe("communication stores in Durable Object SQLite", () => {
  it("keep announcements and weekly notes across a restart", async () => {
    const object = fresh();
    const announcement = {
      id: "ann_one", districtId: "dst_northfield", offeringId: NF.eng9, title: "T", body: "B", publishAt: AT, created: { by: NF.rivera, at: AT },
    } as never;
    await runInDurableObject(object, async (_instance, state) => {
      await new DurableObjectAnnouncementStore(state.storage).put(announcement);
      await new DurableObjectWeeklyNoteStore(state.storage).put({ offeringId: NF.eng9, week: "2026-W44", text: "Read.", updated: { by: NF.rivera, at: AT } } as never);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const announcements = new DurableObjectAnnouncementStore(state.storage);
      expect(await announcements.list(NF.eng9 as never)).toStrictEqual([announcement]);
      expect(await announcements.list("off_other" as never)).toStrictEqual([]);
      const notes = new DurableObjectWeeklyNoteStore(state.storage);
      expect((await notes.get(NF.eng9 as never, "2026-W44"))?.text).toBe("Read.");
      await notes.delete(NF.eng9 as never, "2026-W44");
      expect(await notes.get(NF.eng9 as never, "2026-W44")).toBeUndefined();
      // A malformed record is refused before anything is written.
      await expect(announcements.put({ ...(announcement as object), title: "" } as never)).rejects.toThrow();
    });
  });

  it("add a notification once, keep it per principal, and track what is owed an email", async () => {
    const object = fresh();
    const notification = {
      id: `ntf_${"a".repeat(32)}`, principalId: NF.amara, kind: "announcement", offeringId: NF.eng9, title: "New", ref: {}, occurredAt: AT, createdAt: AT,
    } as never;
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectNotificationStore(state.storage);
      expect(await store.addIfAbsent([notification])).toHaveLength(1);
      expect(await store.addIfAbsent([notification])).toStrictEqual([]);
      expect(await store.pendingEmail()).toHaveLength(1);
      await store.update([{ ...(notification as object), email: { status: "sent", at: AT } } as never]);
      // An update naming another principal changes nothing.
      await store.update([{ ...(notification as object), principalId: NF.rivera, readAt: AT } as never]);
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const store = new DurableObjectNotificationStore(state.storage);
      expect(await store.pendingEmail()).toStrictEqual([]);
      const [stored] = await store.list(NF.amara as PrincipalId);
      expect(stored).toMatchObject({ email: { status: "sent" } });
      expect(stored!.readAt).toBeUndefined();
      expect(await store.list(NF.rivera as PrincipalId)).toStrictEqual([]);
    });
  });

  it("find a feed only by its token's hash, one feed per principal, and claim a digest week once", async () => {
    const object = fresh();
    await runInDurableObject(object, async (_instance, state) => {
      const feeds = new DurableObjectCalendarFeedStore(state.storage);
      await feeds.put({ principalId: NF.amara, tokenHash: "1".repeat(64), createdAt: AT } as never);
      await feeds.put({ principalId: NF.amara, tokenHash: "2".repeat(64), createdAt: AT } as never);
      expect(await feeds.findByHash("1".repeat(64))).toBeUndefined();
      expect(await feeds.findByHash("2".repeat(64))).toMatchObject({ principalId: NF.amara });
      await expect(feeds.put({ principalId: NF.rivera, tokenHash: "2".repeat(64), createdAt: AT } as never)).rejects.toMatchObject({ code: "conflict" });

      const preferences = new DurableObjectPreferenceStore(state.storage);
      expect(await preferences.get(NF.amara as PrincipalId)).toBeUndefined();
      await preferences.put(NF.amara as PrincipalId, { announcements: false, assignments: true, feedback: true, grades: true, digest: true });
      expect((await preferences.get(NF.amara as PrincipalId))?.announcements).toBe(false);

      const ledger = new DurableObjectDigestLedgerStore(state.storage);
      const entry = { guardianPrincipalId: "prn_nf-guardian-okafor", week: "2026-W44", status: "sending", at: AT } as never;
      const claims = await Promise.all([ledger.claim(entry), ledger.claim(entry)]);
      expect(claims.toSorted()).toStrictEqual([false, true]);
      await ledger.finish({ ...(entry as object), status: "failed", reason: "provider-error" } as never);
      expect(await ledger.claim(entry)).toBe(true);
      await ledger.finish({ ...(entry as object), status: "sent" } as never);
      expect(await ledger.claim(entry)).toBe(false);
    });
  });
});
