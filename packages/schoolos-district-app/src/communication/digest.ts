// Communication (SCHO-189): the weekly family digest. For every guardian with a relationship in
// force (ADR-0012), it gathers each child's coming week from the child's own view, keeps only what
// that relationship covers, and emails it once per ISO week, recorded in a send ledger.
//
// Two filters, both from the policy layer, decide what a guardian is told:
//
// 1. The child's view. Every read is made as the child, through the services that decide it, so
//    nothing the child could not read appears: no unreleased feedback, no teacher-only material,
//    no scheduled announcement, and nothing of a sibling's.
// 2. The relationship. Each item is put to `guardianRelationships` (the relationship source the
//    engine reads) as a resource, and kept only if this relationship covers it: in force, of a
//    kind it opens, in an offering it names, for an actively enrolled child.
//
// The email says what is due, what was announced and that feedback was released. It never carries
// a grade, a score or feedback text: those stay behind sign-in.
import type { Caller, OfferingId, PrincipalId, ResourceRef } from "@schoolos/contracts";
import { guardianRelationshipInForce } from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import { guardianRelationships, type GuardianRelationshipStore } from "@schoolos/policy";
import { isDeliverableAddress, type MailMessage, type MailSender } from "./mail.ts";
import { DEFAULT_EMAIL_PREFERENCES, digestWeekOf, isoWeekBounds, type IsoWeek } from "./model.ts";
import { escapeHtml, type CommunicationService } from "./service.ts";
import type { CommunicationStores } from "./stores.ts";

/** One class in a child's digest. */
export interface DigestOffering {
  offeringId: OfferingId;
  courseLabel: string;
  /** Assignments due in the digest's week, soonest first. */
  due: { title: string; dueAt: string }[];
  /** Announcements published in the seven days before the digest. */
  announcements: { title: string; body: string; publishAt: string }[];
  /** Assignments whose feedback was released to the child in the seven days before the digest. */
  feedback: { title: string; releasedAt: string }[];
  /** The teacher's note to families for the week. */
  note?: string;
}

/** One child in a digest: the classes the guardian's relationship to them covers. */
export interface DigestChild {
  studentPrincipalId: PrincipalId;
  displayName: string;
  offerings: DigestOffering[];
}

/** One guardian's digest for one week. */
export interface GuardianDigest {
  guardianPrincipalId: PrincipalId;
  week: IsoWeek;
  /** The Monday the week starts, `YYYY-MM-DD`. */
  weekOf: string;
  children: DigestChild[];
}

/** A digest rendered as an email body. */
export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

/** What the digest is built from. */
export interface FamilyDigestOptions {
  communication: CommunicationService;
  stores: CommunicationStores;
  directory: AcademicStore;
  guardians: GuardianRelationshipStore;
  mail?: MailSender;
  appUrl?: string;
  now: () => Date;
}

const LOOK_BACK_MS = 7 * 86_400_000;
/** Announcement text in a digest is cut to this many characters. */
const DIGEST_BODY_LIMIT = 600;

/** The weekly family digest: building one, previewing it, and the weekly delivery job. */
export class FamilyDigest {
  readonly #options: FamilyDigestOptions;

  constructor(options: FamilyDigestOptions) {
    this.#options = options;
  }

  /**
   * The digest `guardianPrincipalId` gets for the week ahead of now, or `undefined` if they are not
   * an active guardian of the district. A guardian with no relationship in force gets one with no
   * children.
   */
  async build(guardianPrincipalId: PrincipalId): Promise<GuardianDigest | undefined> {
    const now = this.#options.now();
    const snapshot = (await this.#options.directory.load()).snapshot;
    const guardian = snapshot.principals.find((p) => p.id === guardianPrincipalId);
    if (guardian === undefined || guardian.kind !== "guardian" || guardian.status !== "active") return undefined;
    const week = digestWeekOf(now);
    const { start, end } = isoWeekBounds(week);
    const source = guardianRelationships(this.#options.guardians, this.#options.directory, () => now);
    const relationships = (await this.#options.guardians.listForGuardian(guardianPrincipalId))
      .filter((r) => r.guardianPrincipalId === guardianPrincipalId && r.districtId === snapshot.district.id && guardianRelationshipInForce(r, now))
      .toSorted((a, b) => a.studentPrincipalId.localeCompare(b.studentPrincipalId) || a.id.localeCompare(b.id));

    const children: DigestChild[] = [];
    for (const relationship of relationships) {
      const child = snapshot.principals.find((p) => p.id === relationship.studentPrincipalId);
      if (child === undefined || child.kind !== "student" || child.status !== "active") continue;
      /** Whether this relationship, and not merely some relationship, covers `resource`. */
      const covers = async (resource: Omit<ResourceRef, "scope"> & { offeringId: OfferingId }) => {
        const { offeringId, ...rest } = resource;
        const offering = snapshot.offerings.find((o) => o.id === offeringId)!;
        const ref = { ...rest, scope: { level: "offering" as const, districtId: offering.districtId, schoolId: offering.schoolId, offeringId } };
        return (await source.relationships(guardianPrincipalId, ref)).some((fact) => fact.grantId === relationship.id);
      };
      const caller: Caller = {
        principal: { principalId: child.id, districtId: child.districtId },
        channel: "system",
        correlationId: crypto.randomUUID(),
      };
      const offerings: DigestOffering[] = [];
      for (const view of await this.#options.communication.studentView(caller, relationship.offeringIds)) {
        const { offeringId } = view;
        if (!(await covers({ kind: "offering", offeringId, classification: "course" }))) continue;
        const entry: DigestOffering = { offeringId, courseLabel: view.courseLabel, due: [], announcements: [], feedback: [] };
        for (const assignment of view.assignments) {
          const due = Date.parse(assignment.dueAt);
          if (due < Math.max(start.getTime(), now.getTime()) || due >= end.getTime()) continue;
          if (await covers({ kind: "activity", id: assignment.id, offeringId, classification: "course" })) {
            entry.due.push({ title: assignment.title, dueAt: assignment.dueAt });
          }
        }
        for (const announcement of view.announcements) {
          if (!withinLookBack(announcement.publishAt, now)) continue;
          if (await covers({ kind: "announcement", id: announcement.id, offeringId, classification: "course" })) {
            entry.announcements.push({ title: announcement.title, body: clip(announcement.body), publishAt: announcement.publishAt });
          }
        }
        for (const { submission, assignment, releasedAt } of view.releasedFeedback) {
          if (!withinLookBack(releasedAt, now)) continue;
          const ref = { kind: "feedback" as const, id: submission.id, offeringId, classification: "course" as const, ownerPrincipalId: child.id };
          if (await covers(ref)) entry.feedback.push({ title: assignment.title, releasedAt });
        }
        // The weekly note is the teachers' announcement to the class's families.
        const note = await this.#options.communication.noteForDigest(offeringId, week);
        if (note !== undefined && (await covers({ kind: "announcement", offeringId, classification: "course" }))) entry.note = note;
        entry.due.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        entry.announcements.sort((a, b) => b.publishAt.localeCompare(a.publishAt));
        offerings.push(entry);
      }
      children.push({ studentPrincipalId: child.id, displayName: child.displayName, offerings });
    }
    return { guardianPrincipalId, week, weekOf: start.toISOString().slice(0, 10), children };
  }

  /**
   * Sends this week's digest to every active guardian not yet sent it. Each guardian's week is
   * claimed in the ledger before the send, so a week is sent at most once whatever runs overlap; a
   * send the provider refused is marked `failed` and tried again on the next run. Without a mail
   * sender nothing is sent or recorded.
   */
  async runWeeklyJob(): Promise<{ week: IsoWeek; sent: number; skipped: number; failed: number; alreadyDone: number }> {
    const now = this.#options.now();
    const week = digestWeekOf(now);
    const counts = { week, sent: 0, skipped: 0, failed: 0, alreadyDone: 0 };
    const { mail } = this.#options;
    if (mail === undefined) return counts;
    const snapshot = (await this.#options.directory.load()).snapshot;
    const ledger = this.#options.stores.digestLedger;
    for (const guardian of snapshot.principals.filter((p) => p.kind === "guardian" && p.status === "active")) {
      const at = () => this.#options.now().toISOString();
      const existing = await ledger.get(guardian.id, week);
      if (existing !== undefined && existing.status !== "failed") {
        counts.alreadyDone++;
        continue;
      }
      if (!(await ledger.claim({ guardianPrincipalId: guardian.id, week, status: "sending", at: at() }))) {
        counts.alreadyDone++;
        continue;
      }
      const skip = async (reason: "no-address" | "opted-out" | "empty") => {
        await ledger.finish({ guardianPrincipalId: guardian.id, week, status: "skipped", reason, at: at() });
        counts.skipped++;
      };
      const preferences = (await this.#options.stores.preferences.get(guardian.id)) ?? DEFAULT_EMAIL_PREFERENCES;
      if (guardian.email === undefined || !isDeliverableAddress(guardian.email)) {
        await skip("no-address");
        continue;
      }
      if (!preferences.digest) {
        await skip("opted-out");
        continue;
      }
      const digest = await this.build(guardian.id);
      if (digest === undefined || isEmpty(digest)) {
        await skip("empty");
        continue;
      }
      try {
        await mail.send(digestEmail(digest, guardian.email, this.#options.appUrl));
        await ledger.finish({ guardianPrincipalId: guardian.id, week, status: "sent", at: at() });
        counts.sent++;
      } catch {
        await ledger.finish({ guardianPrincipalId: guardian.id, week, status: "failed", reason: "provider-error", at: at() });
        counts.failed++;
      }
    }
    return counts;
  }
}

function withinLookBack(iso: string, now: Date): boolean {
  const time = Date.parse(iso);
  return time <= now.getTime() && now.getTime() - time <= LOOK_BACK_MS;
}

function clip(text: string): string {
  return text.length <= DIGEST_BODY_LIMIT ? text : `${text.slice(0, DIGEST_BODY_LIMIT - 1).trimEnd()}…`;
}

/** Whether a digest has nothing to say. */
export function isEmpty(digest: GuardianDigest): boolean {
  return digest.children.every((child) => child.offerings.every((o) => o.due.length === 0 && o.announcements.length === 0 && o.feedback.length === 0 && o.note === undefined));
}

const dateFormat = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Renders a digest as plain text and simple HTML. Every value from a record is escaped in the HTML. */
export function renderDigest(digest: GuardianDigest, appUrl?: string): RenderedDigest {
  const weekOf = dayFormat.format(new Date(`${digest.weekOf}T00:00:00Z`));
  const names = digest.children.map((c) => c.displayName);
  const subject = names.length === 0 ? `Your weekly update: week of ${weekOf}` : `Weekly update for ${names.join(", ")}: week of ${weekOf}`;
  const text: string[] = [`Week of ${weekOf}`, ""];
  const html: string[] = [`<h1 style="font-size:20px">Week of ${escapeHtml(weekOf)}</h1>`];
  if (digest.children.length === 0) {
    text.push("There is nothing to share this week.");
    html.push("<p>There is nothing to share this week.</p>");
  }
  for (const child of digest.children) {
    text.push(child.displayName, "=".repeat(Math.min(child.displayName.length, 60)));
    html.push(`<h2 style="font-size:18px">${escapeHtml(child.displayName)}</h2>`);
    if (child.offerings.every((o) => o.due.length === 0 && o.announcements.length === 0 && o.feedback.length === 0 && o.note === undefined)) {
      text.push("Nothing new this week.", "");
      html.push("<p>Nothing new this week.</p>");
      continue;
    }
    for (const offering of child.offerings) {
      if (offering.due.length === 0 && offering.announcements.length === 0 && offering.feedback.length === 0 && offering.note === undefined) continue;
      text.push(offering.courseLabel);
      html.push(`<h3 style="font-size:16px">${escapeHtml(offering.courseLabel)}</h3>`);
      if (offering.note !== undefined) {
        text.push(`  Note from the teacher: ${offering.note.replace(/\s*\n\s*/g, " ")}`);
        html.push(`<p><strong>Note from the teacher:</strong> ${escapeHtml(offering.note)}</p>`);
      }
      if (offering.due.length > 0) {
        text.push("  Due this week:", ...offering.due.map((d) => `  - ${d.title} (${dateFormat.format(new Date(d.dueAt))})`));
        html.push("<p>Due this week:</p><ul>", ...offering.due.map((d) => `<li>${escapeHtml(d.title)} (${escapeHtml(dateFormat.format(new Date(d.dueAt)))})</li>`), "</ul>");
      }
      if (offering.announcements.length > 0) {
        text.push("  Announcements:", ...offering.announcements.map((a) => `  - ${a.title}: ${a.body.replace(/\s*\n\s*/g, " ")}`));
        html.push("<p>Announcements:</p><ul>", ...offering.announcements.map((a) => `<li><strong>${escapeHtml(a.title)}</strong>: ${escapeHtml(a.body)}</li>`), "</ul>");
      }
      if (offering.feedback.length > 0) {
        text.push("  New feedback from the teacher on:", ...offering.feedback.map((f) => `  - ${f.title}`));
        html.push("<p>New feedback from the teacher on:</p><ul>", ...offering.feedback.map((f) => `<li>${escapeHtml(f.title)}</li>`), "</ul>");
      }
      text.push("");
    }
  }
  const footer = "You receive this weekly update as a guardian. You can turn it off in your SchoolOS settings, or ask the school.";
  if (appUrl !== undefined) {
    text.push(`Sign in to SchoolOS for details: ${appUrl}`);
    html.push(`<p><a href="${escapeHtml(appUrl)}">Sign in to SchoolOS for details</a></p>`);
  }
  text.push("", footer);
  html.push(`<p style="color:#666">${escapeHtml(footer)}</p>`);
  return { subject, text: `${text.join("\n")}\n`, html: `<!doctype html><html><body>${html.join("")}</body></html>` };
}

/** The digest email to one guardian. */
export function digestEmail(digest: GuardianDigest, to: string, appUrl?: string): MailMessage {
  const { subject, text, html } = renderDigest(digest, appUrl);
  return { to, subject, text, html };
}
