// Small constructors that keep the district files readable. They return plain input objects; each
// district file parses its whole snapshot through the contract schema, so nothing here is trusted.

/** A principal as fixture input, with one identity link from the given issuer. */
export function person(
  districtId: string,
  issuer: string,
  id: string,
  kind: "student" | "staff" | "guardian",
  displayName: string,
  subject: string,
  email?: string,
) {
  return {
    id,
    districtId,
    kind,
    status: "active",
    displayName,
    ...(email === undefined ? {} : { email }),
    externalIdentities: [{ districtId, issuer, subject }],
  };
}

/** An enrollment as fixture input. */
export function enroll(
  districtId: string,
  id: string,
  offeringId: string,
  principalId: string,
  role: "student" | "teacher" | "co-teacher",
  status: "active" | "inactive" = "active",
) {
  return { id, districtId, offeringId, principalId, role, status };
}

/** A teacher or co-teacher role over one offering, as fixture input. */
export function teaches(
  districtId: string,
  principalId: string,
  role: "teacher" | "co-teacher",
  schoolId: string,
  offeringId: string,
  source: "roster" | "local-grant" = "roster",
) {
  return { principalId, role, scope: { level: "offering", districtId, schoolId, offeringId }, source };
}

/**
 * A guardian relationship as fixture input, recorded and (unless `pending`) confirmed by `adminId`
 * at the start of the school year. It opens every guardian-readable kind, and needs no consent
 * because every synthetic student is a minor.
 */
export function guardianOf(
  districtId: string,
  id: string,
  guardianPrincipalId: string,
  studentPrincipalId: string,
  adminId: string,
  status: "active" | "pending" = "active",
) {
  const at = "2026-08-17T15:00:00.000Z";
  return {
    id,
    districtId,
    guardianPrincipalId,
    studentPrincipalId,
    status,
    readableKinds: ["offering", "activity", "feedback", "official-grade", "announcement"],
    consent: "not-required",
    validFrom: at,
    created: { by: adminId, at },
    ...(status === "active" ? { confirmed: { by: adminId, at } } : {}),
  };
}
