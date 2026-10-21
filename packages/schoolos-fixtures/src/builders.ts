// Small constructors that keep the district files readable. They return plain input objects; each
// district file parses its whole snapshot through the contract schema, so nothing here is trusted.

/** A principal as fixture input, with one identity link from the given issuer. */
export function person(
  districtId: string,
  issuer: string,
  id: string,
  kind: "student" | "staff",
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
