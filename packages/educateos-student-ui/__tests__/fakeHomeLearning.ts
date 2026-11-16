// A community installation for the home-learning screens' tests (ADR-0016), backed by the real
// home-learning service over its in-memory store, so scoring, queues, sessions and progress behave
// as the district's do. Policy is the service's own concern in the district and is allowed here.
// The child session is a variable standing in for the cookie: while it is set, every family route
// is refused, as the district refuses them.
import { DistrictApiError, type DistrictApiClient, type RouteInput, type RouteName, type RouteResponse } from "@educateos/api-client";
import { DistrictId, PrincipalId } from "@educateos/contracts";
import { FAMILY_NOTICE_VERSION, HomeLearningService, InMemoryHomeLearningStore } from "@educateos/home-learning";

const D = DistrictId.parse("dst_willowcreek");
const JORDAN = PrincipalId.parse("prn_g-jordan");

/** A fake community with an optional, already set-up family. */
export interface FakeCommunity extends DistrictApiClient {
  calls: { name: RouteName; input: unknown }[];
  service: HomeLearningService;
  /** Makes the next call to `name` fail with `error`. */
  failNext(name: RouteName, error: DistrictApiError): void;
}

const forbidden = (message: string) => new DistrictApiError(403, { code: "forbidden", message });

/** A community where `Jordan Rivers` signs in: not yet joined, joined, or with a family and children already. */
export async function fakeCommunity(options: {
  joined?: boolean;
  children?: readonly string[];
  signup?: "open" | "approval";
  /** Another adult's view of the same community, sharing its service. */
  as?: { service: HomeLearningService; principalId: string; displayName: string };
  retentionDays?: number;
  /** The adult accepted an older notice than the current one. */
  staleNotice?: boolean;
} = {}): Promise<FakeCommunity> {
  const ADULT = { principalId: PrincipalId.parse(options.as?.principalId ?? JORDAN), districtId: D };
  const displayName = options.as?.displayName ?? "Jordan Rivers";
  const store = new InMemoryHomeLearningStore();
  const service = options.as?.service ?? new HomeLearningService({
    store, operator: { name: "Willow Creek" }, authorizer: { authorize: async () => ({ effect: "allow" }) }, districtId: D,
    ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
  });
  let joined = options.joined ?? true;
  let token: string | undefined;
  const calls: FakeCommunity["calls"] = [];
  const failures = new Map<RouteName, DistrictApiError>();
  if (options.children !== undefined) {
    await service.createFamily(ADULT, { name: "The Rivers family", pin: "2468", acceptNotice: FAMILY_NOTICE_VERSION }, displayName);
    for (const name of options.children) await service.addLearner(ADULT, { displayName: name, avatar: "🦊", gradeBand: "K" });
    if (options.staleNotice === true) {
      const family = (await store.loadFamily((await store.familyOfAdult(ADULT.principalId))!))!;
      const adults = family.adults.map((a) => ({ ...a, noticeAccepted: { version: "2026-01-01", at: a.joinedAt } }));
      await store.commitFamily({ ...family, adults, revision: family.revision + 1 }, family.revision);
    }
  }
  const child = async () => (token === undefined ? undefined : service.childSession(ADULT, token));
  const needChild = async () => {
    const open = await child();
    if (open === undefined) throw forbidden("Start practice from your family page first.");
    return open;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: Partial<Record<RouteName, (input: any) => Promise<unknown>>> = {
    "me.get": async () => {
      if (!joined) throw new DistrictApiError(401, { code: "unauthenticated", message: "Not added.", unlinkedSignIn: { issuer: "https://idp.willowcreek.example", subject: "wc-jordan" } });
      const open = await child();
      const learner = open === undefined ? undefined : (await service.practiceHome(ADULT, open)).learner;
      return {
        principalId: ADULT.principalId, districtId: D, kind: "guardian", displayName, roles: [], enrollments: [],
        homeLearning: {
          hasFamily: (await service.home(ADULT)).family !== null,
          childSession: learner === undefined ? null : { learnerId: learner.id, displayName: learner.displayName, avatar: learner.avatar },
        },
      };
    },
    "onboarding.community": async () => ({ homeLearning: true, signup: options.signup ?? "open", notice: service.notice() }),
    "onboarding.joinCommunity": async () => {
      if ((options.signup ?? "open") === "approval") return { outcome: "awaiting-approval" };
      joined = true;
      return { outcome: "joined" };
    },
    "family.home": () => service.home(ADULT),
    "family.create": ({ body }) => service.createFamily(ADULT, body, displayName),
    "family.inviteAdult": async () => {
      const { token, id, expiresAt } = await service.inviteAdult(ADULT);
      return { id, expiresAt, link: `https://safranek.example/family/join#invitation=${encodeURIComponent(token)}` };
    },
    "family.revokeInvitation": ({ params }) => service.revokeInvitation(ADULT, params.invitationId),
    "family.acceptInvitation": ({ body }) => service.acceptInvitation(ADULT, body.token, body.acceptNotice, displayName),
    "family.acceptNotice": ({ body }) => service.acceptNotice(ADULT, body.version),
    "family.readAloud": ({ body }) => service.setReadAloud(ADULT, body.on),
    "family.acknowledgeNewAdults": () => service.acknowledgeNewAdults(ADULT),
    "family.deleteAccount": async () => {
      const { familyDeleted } = await service.leaveForAccountDeletion(ADULT);
      joined = false;
      return { deleted: true, familyDeleted };
    },
    "family.removeAdult": ({ params }) => service.removeAdult(ADULT, params.principalId),
    "family.changePin": ({ body }) => service.changePin(ADULT, body.pin),
    "family.addLearner": ({ body }) => service.addLearner(ADULT, body),
    "family.removeLearner": async ({ params }) => (await service.removeLearner(ADULT, params.learnerId), { removed: true }),
    "family.library": () => service.library(ADULT),
    "family.today": () => service.today(ADULT),
    "family.queueAdd": ({ params, body }) => service.addToQueue(ADULT, params.learnerId, body),
    "family.queueChange": ({ params, body }) => service.changeQueueEntry(ADULT, params.learnerId, params.entryId, body),
    "family.queueRemove": ({ params }) => service.removeQueueEntry(ADULT, params.learnerId, params.entryId),
    "family.progress": ({ params }) => service.progress(ADULT, params.learnerId),
    "family.session": ({ params }) => service.session(ADULT, params.learnerId, params.sessionId),
    "family.correct": ({ params, body }) => service.correct(ADULT, params.learnerId, params.sessionId, body),
    "family.shelfAdd": ({ body }) => service.addShelfItem(ADULT, body),
    "family.shelfRemove": async ({ params }) => (await service.removeShelfItem(ADULT, params.itemId), { removed: true }),
    "family.endChildSessions": async () => ({ ended: await service.endAllChildSessions(ADULT) }),
    "family.startChildSession": async ({ params }) => {
      const started = await service.startChildSession(ADULT, params.learnerId);
      token = started.token;
      return { learnerId: started.learner.id, displayName: started.learner.displayName };
    },
    "learner.home": async () => service.practiceHome(ADULT, await needChild()),
    "learner.start": async ({ params }) => service.startPractice(ADULT, await needChild(), params.entryId),
    "learner.save": async ({ params, body }) => service.saveResponse(ADULT, await needChild(), params.sessionId, body),
    "learner.exit": async ({ body }) => {
      await service.endChildSession(ADULT, await needChild(), body.pin);
      token = undefined;
      return { ended: true };
    },
  };

  return {
    calls,
    service,
    failNext: (name, error) => void failures.set(name, error),
    async call<N extends RouteName>(name: N, ...args: [RouteInput<N>?]): Promise<RouteResponse<N>> {
      const input = args[0] ?? {};
      calls.push({ name, input });
      const failure = failures.get(name);
      if (failure !== undefined) {
        failures.delete(name);
        throw failure;
      }
      if (name.startsWith("family.") && await child() !== undefined) throw forbidden("A child is practicing on this device.");
      const handler = handlers[name];
      if (handler === undefined) throw forbidden("This part of EducateOS is not available to your account.");
      try {
        return await handler(input) as RouteResponse<N>;
      } catch (error) {
        if (error instanceof DistrictApiError) throw error;
        const code = (error as { code?: string }).code;
        if (code === "forbidden") throw forbidden((error as Error).message);
        if (code === "not-found") throw new DistrictApiError(404, { code: "not-found", message: (error as Error).message });
        if (code === "conflict") throw new DistrictApiError(409, { code: "conflict", message: (error as Error).message });
        throw new DistrictApiError(400, { code: "validation-failed", message: "Invalid." });
      }
    },
  };
}
