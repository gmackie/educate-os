import { z } from "zod";
import { PrincipalId, OfferingId, type ResourceRef } from "@educateos/contracts";
import type { DistrictApp } from "@educateos/district-app";

const identifier = z.string().min(1).max(256);
/**
 * Workshop actions inside workspaces the Workshop's own sharing graph already admits the caller to
 * (SCHO-309). The district knows nothing about those workspaces, so it grants these by principal
 * kind alone; ownership and collaborator roles are still the Workshop's to check.
 */
const WorkspaceAction = z.enum([
  "workspace.create.query", "workshop.authoring.query", "gadget.create", "gadget.execute",
  "agent.execute", "workspace.share", "blueprint.publish", "blueprint.import",
]);
/** Deployment-owned grants, never supplied by a Workshop caller. Absent means deny all. */
export const WorkshopPolicySettings = z.strictObject({
  personalCreation: z.boolean(),
  /** Exact blueprint IDs approved for personal work; no prefix or URL matching. */
  personalBlueprints: z.array(identifier),
  /** A blueprint authorizes class authoring only in the stored offering named here. */
  classBlueprints: z.array(z.strictObject({ blueprintId: identifier, offeringId: OfferingId })),
  /** Exact provider/model pairs administrators may configure. */
  models: z.array(z.strictObject({ provider: identifier, modelId: identifier })),
  /** Exact connector grants. An omitted account permits only initial account creation. */
  connectors: z.array(z.strictObject({
    vendorId: identifier,
    accountId: z.number().int().nonnegative().optional(),
    resourceUrlPatterns: z.array(z.string().min(1).max(2048)),
    resources: z.array(z.string().min(1).max(2048)),
  })),
  /**
   * Which active kinds may perform which workspace actions. Absent or empty denies them all, so
   * every Gadget, agent turn and share is refused (SCHO-309). Executing grants are only safe because
   * the Workshop restarts whatever a principal holds once they leave this list or lose standing.
   */
  workspaceActions: z.array(z.strictObject({
    kind: z.enum(["staff", "student"]),
    actions: z.array(WorkspaceAction),
  })).optional(),
});
/** Validated deployment policy. */
export type WorkshopPolicySettings = z.infer<typeof WorkshopPolicySettings>;

// This is the domain parser for untrusted RPC data, including direct Worker/DO calls. The
// entrypoint's generated validator also enforces the shared wire contract, not these domain limits.
const base = { userId: z.string().startsWith("principal:").max(300) };
const workspaceScoped = (action: "gadget.create" | "gadget.execute" | "agent.execute" | "workspace.share" | "blueprint.publish") =>
  z.strictObject({ ...base, action: z.literal(action), workspaceId: identifier });
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.literal("workspace.create.query") }),
  z.strictObject({ ...base, action: z.literal("workshop.authoring.query"), operation: z.enum(["create", "adapt"]), sourceBlueprintId: identifier.optional() }),
  z.strictObject({ ...base, action: z.literal("blueprint.import") }),
  workspaceScoped("gadget.create"), workspaceScoped("gadget.execute"), workspaceScoped("agent.execute"),
  workspaceScoped("workspace.share"), workspaceScoped("blueprint.publish"),
  z.strictObject({ ...base, action: z.literal("workspace.create"), workspaceId: identifier, sourceBlueprintId: identifier.optional() }),
  z.strictObject({ ...base, action: z.literal("model.configure"), provider: identifier, modelId: identifier }),
  z.strictObject({ ...base, action: z.literal("gatekeeper.connect"), vendorId: identifier, accountId: z.number().int().nonnegative().optional(), resourceUrlPatterns: z.array(z.string().min(1).max(2048)).max(100).optional() }),
  z.strictObject({ ...base, action: z.literal("resource.acquire"), vendorId: identifier, accountId: z.number().int().nonnegative().optional(), resource: z.string().min(1).max(2048) }),
]);
const denied = { outcome: "deny", message: "District policy does not permit this capability." } as const;

/**
 * District mint policy. Resolves current facts on every call; strings never confer authority.
 * The binding is a trusted backend capability: only Workshop may assert its persisted userId.
 */
export async function authorizeWorkshopCapability(
  app: Pick<DistrictApp, "districtId" | "stores" | "engine">,
  settings: WorkshopPolicySettings | undefined,
  input: unknown,
) {
  const parsed = requestSchema.safeParse(input);
  if (settings === undefined || !parsed.success) return denied;
  const request = parsed.data;
  const principalId = PrincipalId.safeParse(request.userId.slice("principal:".length));
  if (!principalId.success) return denied;
  const { snapshot } = await app.stores.directory.load();
  if (snapshot.district.id !== app.districtId) return denied;
  const principal = snapshot.principals.find((p) => p.id === principalId.data);
  if (principal === undefined || principal.districtId !== app.districtId || principal.status !== "active" ||
    (principal.kind !== "student" && principal.kind !== "staff")) return denied;

  if (request.action !== "workspace.create" && request.action !== "model.configure" &&
    request.action !== "gatekeeper.connect" && request.action !== "resource.acquire") {
    const action = request.action;
    const granted = (settings.workspaceActions ?? []).some((g) => g.kind === principal.kind && g.actions.includes(action));
    return granted ? { outcome: "allow" as const } : denied;
  }
  const subject = { principalId: principal.id, districtId: app.districtId };
  const districtScope = { level: "district", districtId: app.districtId } as const;
  let action: "create" | "update";
  let resource: ResourceRef;
  let termState;
  if (request.action === "workspace.create") {
    action = "create";
    const classes = settings.classBlueprints.filter((b) => b.blueprintId === request.sourceBlueprintId);
    if (classes.length > 0) {
      // Ambiguous mappings never let a caller choose a more privileged scope.
      if (classes.length !== 1 || principal.kind !== "staff" || settings.personalBlueprints.includes(request.sourceBlueprintId!)) return denied;
      const offering = snapshot.offerings.find((o) => o.id === classes[0]!.offeringId && o.districtId === app.districtId);
      const term = snapshot.terms.find((t) => t.id === offering?.termId && t.districtId === app.districtId);
      if (offering === undefined || term === undefined || term.state !== "active") return denied;
      termState = term.state;
      resource = { kind: "course-workspace", classification: "teacher-only", scope: {
        level: "offering", districtId: app.districtId, schoolId: offering.schoolId, offeringId: offering.id,
      } };
    } else {
      if (!settings.personalCreation || (request.sourceBlueprintId !== undefined && !settings.personalBlueprints.includes(request.sourceBlueprintId))) return denied;
      resource = { kind: "personal-workspace", classification: "personal-private", scope: districtScope, ownerPrincipalId: principal.id };
    }
  } else {
    // These are deployment-wide configuration powers, never school-admin or teacher powers.
    // ABAC checks district-admin authority at district scope after the exact grant check.
    if (request.action === "model.configure") {
      if (!settings.models.some((m) => m.provider === request.provider && m.modelId === request.modelId)) return denied;
    } else {
      const grant = settings.connectors.find((g) => g.vendorId === request.vendorId && g.accountId === request.accountId);
      if (grant === undefined) return denied;
      if (request.action === "gatekeeper.connect") {
        // An omitted list may mean unrestricted access to a provider. Require the entire
        // approved set, including emptiness, rather than treating omission as a safe subset.
        const requested = new Set(request.resourceUrlPatterns ?? []);
        const approved = new Set(grant.resourceUrlPatterns);
        if (requested.size !== approved.size || [...requested].some((p) => !approved.has(p))) return denied;
      } else if (!grant.resources.includes(request.resource)) return denied;
    }
    if (principal.kind !== "staff") return denied;
    action = "update";
    resource = { kind: "district", classification: "district-internal", scope: districtScope };
  }
  const result = await app.engine.decide({ subject, action, resource, context: {
    channel: "http", ...(termState === undefined ? {} : { termState }),
  } });
  return result.decision.effect === "allow" ? { outcome: "allow" as const } : denied;
}
