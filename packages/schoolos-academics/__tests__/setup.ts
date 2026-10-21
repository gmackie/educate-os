import {
  DistrictId,
  PrincipalId,
  type Authorizer,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import {
  AcademicDirectory,
  InMemoryAcademicStore,
  RoleTableAuthorizer,
  storePrincipalFacts,
  type AuthorityMap,
  type Caller,
} from "../src/index.ts";

/** SchoolOS owns every record type. */
export const ALL_LOCAL: AuthorityMap = {
  school: "local",
  term: "local",
  course: "local",
  offering: "local",
  enrollment: "local",
  principal: "local",
};

/** A OneRoster feed owns the roster: offerings, enrollments and principals. */
export const ROSTER_EXTERNAL: AuthorityMap = {
  ...ALL_LOCAL,
  offering: "external:oneroster",
  enrollment: "external:oneroster",
  principal: "external:oneroster",
};

/** A directory over a fresh copy of `snapshot`, authorized by the role table unless overridden. */
export function directoryFor(
  snapshot: DistrictDirectorySnapshot = NORTHFIELD,
  options: { authority?: AuthorityMap; authorizer?: Authorizer } = {},
) {
  const store = InMemoryAcademicStore.seeded(snapshot);
  const authority = options.authority ?? ALL_LOCAL;
  const directory = new AcademicDirectory({
    store,
    authority,
    authorizer: options.authorizer ?? new RoleTableAuthorizer(storePrincipalFacts(store)),
  });
  return { store, directory, authority };
}

/** A verified Northfield caller on the HTTP channel. */
export function nf(principalId: string): Caller {
  return {
    principal: { principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse("dst_northfield") },
    channel: "http",
  };
}

/** Well-known Northfield principals. */
export const NF = {
  admin: nf("prn_nf-district-admin"),
  highPrincipal: nf("prn_nf-principal-high"),
  morgan: nf("prn_nf-morgan-lee"),
  patel: nf("prn_nf-teacher-patel"),
  amara: nf("prn_nf-student-amara"),
  chidi: nf("prn_nf-student-chidi"),
  dmitri: nf("prn_nf-student-dmitri"),
};

/** Riverbend's district admin, who has no standing in Northfield. */
export const RB_ADMIN: Caller = {
  principal: { principalId: PrincipalId.parse("prn_rb-district-admin"), districtId: DistrictId.parse("dst_riverbend") },
  channel: "http",
};

/** Asserts a promise rejects with a SchoolOsError of the given code. */
export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === code) return error;
    throw new Error(`expected ${code}, got ${String(error)}`, { cause: error });
  }
  throw new Error(`expected ${code}, but it succeeded`);
}
