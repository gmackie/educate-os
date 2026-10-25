import {
  DistrictId,
  PrincipalId,
  type Action,
  type AuthorizationRequest,
  type Classification,
  type DistrictDirectorySnapshot,
  type PolicySettings,
  type RequestChannel,
  type ResourceKind,
  type ResourceRef,
  type TermState,
} from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  directoryPolicyInformation,
  InMemoryPolicyAuditSink,
  PolicyEngine,
  type PolicyRule,
} from "../src/index.ts";

/** A floor that lets students share conversations and teachers read what is shared. */
export const SHARING_FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The strict end of every setting. */
export const STRICT_FLOOR: PolicySettings = {
  ...SHARING_FLOOR,
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
};

/** An engine over a fresh store seeded from `snapshot`, with one policy floor everywhere. */
export function engineFor(
  snapshot: DistrictDirectorySnapshot = NORTHFIELD,
  options: { floor?: PolicySettings; rules?: readonly PolicyRule[] } = {},
) {
  const store = InMemoryAcademicStore.seeded(snapshot);
  const audit = new InMemoryPolicyAuditSink();
  const floor = options.floor ?? SHARING_FLOOR;
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(store, { effectivePolicy: async () => floor }),
    audit,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  return { store, audit, engine };
}

/** A verified subject in a district. */
export function subject(principalId: string, districtId: string = principalId.startsWith("prn_rb-") ? "dst_riverbend" : "dst_northfield") {
  return { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse(districtId) };
}

/** Well-known principals. */
export const P = {
  nfAdmin: subject("prn_nf-district-admin"),
  highPrincipal: subject("prn_nf-principal-high"),
  morgan: subject("prn_nf-morgan-lee"),
  rivera: subject("prn_nf-teacher-rivera"),
  chen: subject("prn_nf-teacher-chen"),
  patel: subject("prn_nf-teacher-patel"),
  amara: subject("prn_nf-student-amara"),
  chidi: subject("prn_nf-student-chidi"),
  dmitri: subject("prn_nf-student-dmitri"),
  elena: subject("prn_nf-student-elena"),
  rbAdmin: subject("prn_rb-district-admin"),
  rbMorgan: subject("prn_rb-morgan-lee"),
  rbHaddad: subject("prn_rb-teacher-haddad"),
  ines: subject("prn_rb-student-ines"),
  kai: subject("prn_rb-student-kai"),
};

/** The scope and term state of an offering in a snapshot. */
export function inOffering(offeringId: string, snapshot: DistrictDirectorySnapshot = NORTHFIELD) {
  const offering = snapshot.offerings.find((o) => o.id === offeringId);
  if (offering === undefined) throw new Error(`no offering ${offeringId}`);
  const term = snapshot.terms.find((t) => t.id === offering.termId)!;
  return {
    scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id } as const,
    termState: term.state,
  };
}

/** A resource in an offering. */
export function courseResource(
  offeringId: string,
  kind: ResourceKind,
  classification: Classification,
  options: { id?: string; owner?: string; snapshot?: DistrictDirectorySnapshot } = {},
): { resource: ResourceRef; termState: TermState } {
  const { scope, termState } = inOffering(offeringId, options.snapshot);
  return {
    resource: {
      kind,
      ...(options.id === undefined ? {} : { id: options.id }),
      scope,
      classification,
      ...(options.owner === undefined ? {} : { ownerPrincipalId: PrincipalId.parse(options.owner) }),
    },
    termState,
  };
}

/** A personal resource, which lives at its owner's district and belongs to no term. */
export function personalResource(
  kind: ResourceKind,
  owner: string,
  options: { id?: string; classification?: Classification; districtId?: string } = {},
): { resource: ResourceRef } {
  return {
    resource: {
      kind,
      ...(options.id === undefined ? {} : { id: options.id }),
      scope: { level: "district", districtId: DistrictId.parse(options.districtId ?? "dst_northfield") },
      classification: options.classification ?? "personal-private",
      ownerPrincipalId: PrincipalId.parse(owner),
    },
  };
}

/** A complete authorization request. */
export function req(
  who: AuthorizationRequest["subject"],
  action: Action,
  target: { resource: ResourceRef; termState?: TermState },
  channel: RequestChannel = "http",
): AuthorizationRequest {
  return {
    subject: who,
    action,
    resource: target.resource,
    context: { channel, ...(target.termState === undefined ? {} : { termState: target.termState }) },
  };
}

/** A copy of a snapshot with changes applied, for scenarios the fixtures do not hold. */
export function withChanges(
  snapshot: DistrictDirectorySnapshot,
  change: (draft: DistrictDirectorySnapshot) => void,
): DistrictDirectorySnapshot {
  const draft = structuredClone(snapshot);
  change(draft);
  return draft;
}
