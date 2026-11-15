import { z } from "zod";
import { ActivityScope, Id, Operation, type ActivityRequest } from "./contracts.ts";
import type { ActivityAuthority } from "./runtime.ts";

/** Recorded by a trusted host UI after explicit user consent, never deserialized from a student tool call. */
export const SessionConsent = z.strictObject({
  sessionId: Id, actorId: Id, decisionId: Id, scope: ActivityScope,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  actions: z.array(z.strictObject({ adapterId: Id, actionId: Id, operation: Operation })).max(32),
}).refine((c) => {
  const duration = Date.parse(c.expiresAt) - Date.parse(c.issuedAt);
  return duration > 0 && duration <= 60 * 60 * 1000;
}, "Consent must expire within one hour");
/** Revocable, bounded session policy. Missing consent or policy is default deny. */
export function sessionAuthority(options: {
  consent?: z.infer<typeof SessionConsent>;
  now?: () => Date;
  /** Current district membership, project ownership and registry release/contract approval check. */
  allowed?: (request: ActivityRequest) => Promise<boolean>;
  /** Fresh trusted local UI confirmation for this exact request digest; absent means no side effects. */
  approveSideEffect?: (request: ActivityRequest, digest: string) => Promise<string | null>;
} = {}): ActivityAuthority & { revoke(): void } {
  const consent = options.consent ? SessionConsent.parse(options.consent) : undefined;
  const now = options.now ?? (() => new Date());
  let revoked = false;
  const active = () => !revoked && consent && now().getTime() >= Date.parse(consent.issuedAt)
    && now().getTime() < Date.parse(consent.expiresAt);
  return {
    revoke() { revoked = true; },
    async approve(request, digest) {
      if (!consent || !active() || request.sessionId !== consent.sessionId
          || Object.keys(consent.scope).some((key) => consent.scope[key as keyof ActivityScope] !== request.scope[key as keyof ActivityScope])
          || !consent.actions.some((a) => a.adapterId === request.adapterId && a.actionId === request.actionId && a.operation === request.operation)
          || !await options.allowed?.(request) || !active()) return null;
      const sideEffect = request.operation === "run-scenario" || request.operation === "mutate";
      const decisionId = sideEffect ? await options.approveSideEffect?.(request, digest) : consent.decisionId;
      if (!decisionId || !active()) return null;
      return { actorId: consent.actorId, decisionId: Id.parse(decisionId) };
    },
  };
}
