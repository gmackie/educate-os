// Home-learning routes (ADR-0016): a family adult's management of their family and a child's
// practice inside a child session, plus the community sign-up that makes a newcomer a family adult.
// Kept apart from app.ts so the feature reads as one piece; app.ts builds the request context these
// handlers run in and enforces the child session before any of them runs.
import {
  EducateOsError,
  PrincipalId,
  checkDirectoryIntegrity,
  externalIdentityKey,
  type Caller,
  type DistrictDirectorySnapshot,
  type VerifiedIdentity,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";
import { requestNewPrincipalLink } from "@educateos/identity";
import { newIdentityRequestId, type IdentityLinkAdminService, type IdentityLinkStore } from "@educateos/identity-links";
import { CHILD_SESSION_MAX_DAYS, type ChildSession, type HomeLearningService } from "@educateos/home-learning";
import type { ParsedRouteInput, RouteResponse, WithCookie } from "./routes.ts";

/** How a community installation admits newcomers (ADR-0016). */
export interface HomeLearningOptions {
  /**
   * `open`: anyone the installation's Cloudflare Access policy admits becomes a family adult on
   * their first visit. `approval`: their request waits for a community administrator, as an
   * identity link. `invite-only`: no self sign-up; an administrator adds people.
   */
  signup: "open" | "approval" | "invite-only";
  /** Days a practice session is kept after it started; the hourly job deletes older ones. Unset keeps them. */
  retentionDays?: number;
  /** How families reach whoever runs the installation, stated in the family notice. */
  contact?: string;
}

/** The routes this module handles. */
export type HomeLearningRouteName =
  | "family.home" | "family.create" | "family.rename" | "family.changePin" | "family.delete" | "family.export"
  | "family.addLearner" | "family.updateLearner" | "family.removeLearner"
  | "family.library" | "family.previewActivity" | "family.today"
  | "family.queueAdd" | "family.queueChange" | "family.queueRemove"
  | "family.progress" | "family.session" | "family.correct"
  | "family.shelfAdd" | "family.shelfRemove"
  | "family.startChildSession" | "family.endChildSessions"
  | "family.inviteAdult" | "family.revokeInvitation" | "family.acceptInvitation" | "family.removeAdult"
  | "family.acceptNotice" | "family.readAloud" | "family.deleteAccount"
  | "learner.session" | "learner.home" | "learner.start" | "learner.save" | "learner.exit"
  | "admin.familySignups";

/** What a home-learning handler needs from app.ts's request context. */
export interface HomeLearningRequestContext {
  readonly subject: VerifiedPrincipal;
  /** The request's origin, which an invitation link is built on. */
  readonly origin: string;
  readonly snapshot: DistrictDirectorySnapshot;
  readonly caller: Caller;
  identityLinks(): IdentityLinkAdminService;
  /** The browser's open child session, resolved once per request, or undefined. */
  readonly childSession: ChildSession | undefined;
  homeLearning(): HomeLearningService;
  /** Removes the caller's own principal, and so their sign-in, from the directory. */
  deleteOwnPrincipal(): Promise<void>;
}

/** The cookie a child session rides in. `__Host-` pins it to this origin, path `/`, over HTTPS. */
export const CHILD_SESSION_COOKIE = "__Host-educateos-child";

/** The child-session token a request carries, or undefined. */
export function childSessionToken(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CHILD_SESSION_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

/** The `Set-Cookie` value that starts a child session. It lasts until an adult ends it. */
export function childSessionCookie(token: string): string {
  return `${CHILD_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * CHILD_SESSION_MAX_DAYS}`;
}

/** The `Set-Cookie` value that clears it. */
export function clearedChildSessionCookie(): string {
  return `${CHILD_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/**
 * Refuses a request a browser in a child session may not make: anything but practice, its status,
 * and who is signed in. A learner route outside a child session is refused too, except its status.
 */
export function enforceChildSession(routeName: string, surface: string, child: ChildSession | undefined): void {
  if (child !== undefined) {
    if (surface === "learner" || routeName === "me.get") return;
    throw new EducateOsError("forbidden", "A child is practicing on this device. Ask a grown-up to finish practice first.");
  }
  if (surface === "learner" && routeName !== "learner.session") {
    throw new EducateOsError("forbidden", "Start practice from your family page first.");
  }
}

const nameOf = (ctx: HomeLearningRequestContext): string | undefined =>
  ctx.snapshot.principals.find((p) => p.id === ctx.subject.principalId)?.displayName;

const needsChild = (ctx: HomeLearningRequestContext): ChildSession => {
  if (ctx.childSession === undefined) throw new EducateOsError("forbidden", "Start practice from your family page first.");
  return ctx.childSession;
};

type Handler<C, N extends HomeLearningRouteName> = (ctx: C, input: ParsedRouteInput<N>) => Promise<
  N extends "family.startChildSession" | "learner.exit" ? WithCookie<RouteResponse<N>> : RouteResponse<N>
>;
type HomeLearningHandlers<C> = { [N in HomeLearningRouteName]: Handler<C, N> };

/** The home-learning handlers, typed against app.ts's request context. */
export function homeLearningHandlers<C extends HomeLearningRequestContext>(): HomeLearningHandlers<C> {
  return {
    "family.home": (ctx) => ctx.homeLearning().home(ctx.subject),
    "family.create": (ctx, { body }) => ctx.homeLearning().createFamily(ctx.subject, body, nameOf(ctx)),
    "family.inviteAdult": async (ctx) => {
      const { token, id, expiresAt } = await ctx.homeLearning().inviteAdult(ctx.subject);
      // The token rides in the fragment, so no server or proxy logs it.
      const link = new URL("/family/join", ctx.origin);
      link.hash = new URLSearchParams({ invitation: token }).toString();
      return { id, expiresAt, link: link.toString() };
    },
    "family.revokeInvitation": (ctx, { params }) => ctx.homeLearning().revokeInvitation(ctx.subject, params.invitationId),
    "family.acceptInvitation": (ctx, { body }) => ctx.homeLearning().acceptInvitation(ctx.subject, body.token, body.acceptNotice, nameOf(ctx)),
    "family.acceptNotice": (ctx, { body }) => ctx.homeLearning().acceptNotice(ctx.subject, body.version),
    "family.readAloud": (ctx, { body }) => ctx.homeLearning().setReadAloud(ctx.subject, body.on),
    "family.deleteAccount": async (ctx) => {
      // The family first, through policy, so a refusal there leaves the sign-in in place.
      const { familyDeleted } = await ctx.homeLearning().leaveForAccountDeletion(ctx.subject);
      await ctx.deleteOwnPrincipal();
      return { deleted: true as const, familyDeleted };
    },
    "family.removeAdult": (ctx, { params }) => ctx.homeLearning().removeAdult(ctx.subject, params.principalId),
    "family.rename": (ctx, { body }) => ctx.homeLearning().renameFamily(ctx.subject, body.name),
    "family.changePin": (ctx, { body }) => ctx.homeLearning().changePin(ctx.subject, body.pin),
    "family.delete": async (ctx) => {
      await ctx.homeLearning().deleteFamily(ctx.subject);
      return { deleted: true as const };
    },
    "family.export": (ctx) => ctx.homeLearning().exportFamily(ctx.subject),
    "family.addLearner": (ctx, { body }) => ctx.homeLearning().addLearner(ctx.subject, body),
    "family.updateLearner": (ctx, { params, body }) => ctx.homeLearning().updateLearner(ctx.subject, params.learnerId, body),
    "family.removeLearner": async (ctx, { params }) => {
      await ctx.homeLearning().removeLearner(ctx.subject, params.learnerId);
      return { removed: true as const };
    },
    "family.library": (ctx) => ctx.homeLearning().library(ctx.subject),
    "family.previewActivity": (ctx, { params }) => ctx.homeLearning().previewActivity(ctx.subject, { pack: params.pack, version: params.version, activity: params.activity }),
    "family.today": (ctx) => ctx.homeLearning().today(ctx.subject),
    "family.queueAdd": (ctx, { params, body }) => ctx.homeLearning().addToQueue(ctx.subject, params.learnerId, body),
    "family.queueChange": (ctx, { params, body }) => ctx.homeLearning().changeQueueEntry(ctx.subject, params.learnerId, params.entryId, body),
    "family.queueRemove": (ctx, { params }) => ctx.homeLearning().removeQueueEntry(ctx.subject, params.learnerId, params.entryId),
    "family.progress": (ctx, { params }) => ctx.homeLearning().progress(ctx.subject, params.learnerId),
    "family.session": (ctx, { params }) => ctx.homeLearning().session(ctx.subject, params.learnerId, params.sessionId),
    "family.correct": (ctx, { params, body }) => ctx.homeLearning().correct(ctx.subject, params.learnerId, params.sessionId, body),
    "family.shelfAdd": (ctx, { body }) => ctx.homeLearning().addShelfItem(ctx.subject, body),
    "family.shelfRemove": async (ctx, { params }) => {
      await ctx.homeLearning().removeShelfItem(ctx.subject, params.itemId);
      return { removed: true as const };
    },
    "family.startChildSession": async (ctx, { params }) => {
      const { token, learner } = await ctx.homeLearning().startChildSession(ctx.subject, params.learnerId);
      return { body: { learnerId: learner.id, displayName: learner.displayName }, setCookie: childSessionCookie(token) };
    },
    "family.endChildSessions": async (ctx) => ({ ended: await ctx.homeLearning().endAllChildSessions(ctx.subject) }),
    "learner.session": async (ctx) => {
      if (ctx.childSession === undefined) return { active: false as const };
      const home = await ctx.homeLearning().practiceHome(ctx.subject, ctx.childSession);
      return { active: true as const, learnerId: home.learner.id, displayName: home.learner.displayName, avatar: home.learner.avatar };
    },
    "learner.home": (ctx) => ctx.homeLearning().practiceHome(ctx.subject, needsChild(ctx)),
    "learner.start": (ctx, { params }) => ctx.homeLearning().startPractice(ctx.subject, needsChild(ctx), params.entryId),
    "learner.save": (ctx, { params, body }) => ctx.homeLearning().saveResponse(ctx.subject, needsChild(ctx), params.sessionId, body),
    "admin.familySignups": async (ctx) => (await ctx.identityLinks().listPending(ctx.caller)).flatMap((request) =>
      request.kind === "identity-link" && request.status === "pending" && request.link.newPrincipal?.kind === "guardian"
        ? [{ requestId: request.requestId, displayName: request.link.newPrincipal.displayName, signIn: { issuer: request.link.identity.issuer, subject: request.link.identity.subject }, requestedAt: request.link.requestedAt }]
        : []),
    "learner.exit": async (ctx, { body }) => {
      await ctx.homeLearning().endChildSession(ctx.subject, needsChild(ctx), body.pin);
      return { body: { ended: true as const }, setCookie: clearedChildSessionCookie() };
    },
  };
}

/** What community sign-up needs. */
export interface CommunityJoinDependencies {
  directory: AcademicStore;
  identityLinks: IdentityLinkStore;
  options: HomeLearningOptions | undefined;
  now: () => Date;
}

/**
 * Makes a verified sign-in that is nobody's principal yet a family adult (a guardian principal with
 * no school relationship), or records its request for an administrator, as the community's sign-up
 * setting says. A guardian principal grants nothing until its adult starts a family.
 *
 * @throws EducateOsError `forbidden` where sign-up is invite-only or home learning is off; `conflict`
 *   if the sign-in already belongs to someone.
 */
export async function joinCommunity(deps: CommunityJoinDependencies, identity: VerifiedIdentity, displayName: string): Promise<{ outcome: "joined" | "awaiting-approval" }> {
  const signup = deps.options?.signup;
  if (signup === undefined || signup === "invite-only") {
    throw new EducateOsError("forbidden", "This community adds families by invitation. Ask its organizer to add you.");
  }
  const { version, snapshot } = await deps.directory.load();
  const key = externalIdentityKey({ districtId: snapshot.district.id, issuer: identity.issuer, subject: identity.subject });
  if (snapshot.principals.some((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key))) {
    throw new EducateOsError("conflict", "You've already joined.");
  }
  const principalId = PrincipalId.parse(`prn_g-${crypto.randomUUID()}`);
  const at = deps.now().toISOString();
  // Checks the issuer is trusted, the credential is a person's, and the identity is unlinked.
  const link = requestNewPrincipalLink(snapshot, { principalId, newPrincipal: { kind: "guardian", displayName }, identity, requestedAt: at });
  if (signup === "approval") {
    const pending = (await deps.identityLinks.read()).open()
      .some((r) => r.kind === "identity-link" && r.link.identity.issuer === identity.issuer && r.link.identity.subject === identity.subject);
    if (pending) return { outcome: "awaiting-approval" };
    await deps.identityLinks.transact(() => ({ append: [{ type: "link-requested", requestId: newIdentityRequestId(), link }], result: undefined }));
    return { outcome: "awaiting-approval" };
  }
  const next: DistrictDirectorySnapshot = {
    ...snapshot,
    principals: [...snapshot.principals, {
      id: principalId,
      districtId: snapshot.district.id,
      kind: "guardian",
      status: "active",
      displayName,
      externalIdentities: [link.identity],
    }],
  };
  if (checkDirectoryIntegrity(next).length > 0) throw new EducateOsError("conflict", "That sign-in can't join this community.");
  await deps.directory.commit(next, version);
  return { outcome: "joined" };
}

/**
 * Removes a community member's own principal from the directory, with the sign-in identifier it
 * holds (ADR-0016). Only a guardian principal that nothing else in the directory refers to can go
 * this way; anyone else (an organizer, or a guardian a school roster knows) asks an administrator.
 *
 * @throws EducateOsError `forbidden` for any other principal.
 */
export async function deleteCommunityPrincipal(directory: AcademicStore, principalId: PrincipalId): Promise<void> {
  const refuse = () => new EducateOsError("forbidden", "Your account can't be deleted here. Ask this community's organizer.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { version, snapshot } = await directory.load();
    const principal = snapshot.principals.find((p) => p.id === principalId);
    if (principal === undefined) return;
    if (principal.kind !== "guardian") throw refuse();
    const next: DistrictDirectorySnapshot = { ...snapshot, principals: snapshot.principals.filter((p) => p.id !== principalId) };
    // A principal something still names (a relationship, an enrollment) fails integrity, so stays.
    if (checkDirectoryIntegrity(next).length > 0) throw refuse();
    try {
      await directory.commit(next, version);
      return;
    } catch (error) {
      if (!(error instanceof EducateOsError && error.code === "conflict") || attempt === 2) throw error;
    }
  }
}
