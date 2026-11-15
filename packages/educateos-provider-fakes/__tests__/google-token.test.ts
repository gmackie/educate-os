// The fake of Google's token endpoint for delegated service accounts: a signed JWT-bearer assertion
// acting as a Workspace user gets a Classroom token, within exactly the delegated scopes.
import { importPKCS8, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { CLASSROOM_SCOPES as S, GOOGLE_TOKEN_ENDPOINT, GoogleClassroomFake, GoogleServiceAccountTokenFake, syntheticServiceAccount } from "../src/google-classroom/index.ts";
import { SAMPLE_DISTRICT } from "../src/sample.ts";

const SCOPES = [S.coursesReadonly, S.rostersReadonly];
const ADMIN = SAMPLE_DISTRICT.people.find((p) => p.id === "mw-t-okafor")!.email;

async function setup() {
  const account = await syntheticServiceAccount("roster@synthetic-project.iam.gserviceaccount.com");
  const classroom = new GoogleClassroomFake({ seed: SAMPLE_DISTRICT });
  const tokens = new GoogleServiceAccountTokenFake({
    classroom, people: SAMPLE_DISTRICT.people,
    delegations: [{ clientEmail: account.keyFile.client_email, publicKeyPem: account.publicKeyPem, scopes: SCOPES }],
  });
  const assertion = async (claims: { sub?: string; scope?: string }, key = account.keyFile.private_key) => {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({ scope: claims.scope ?? SCOPES.join(" "), sub: claims.sub ?? ADMIN })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(account.keyFile.client_email)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(await importPKCS8(key, "RS256"));
  };
  const exchange = async (jwt: string) => {
    const response = await tokens.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  };
  return { account, classroom, tokens, assertion, exchange };
}

describe("the delegated service account token endpoint", () => {
  it("issues a token that the Classroom fake accepts, acting as the Workspace user", async () => {
    const { assertion, exchange, classroom } = await setup();
    const { status, body } = await exchange(await assertion({}));
    expect(status).toBe(200);
    expect(body.token_type).toBe("Bearer");
    const courses = await classroom.fetch("https://classroom.googleapis.com/v1/courses", { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(courses.status).toBe(200);
  });

  it("refuses a scope the domain didn't delegate, an unknown user, a foreign key and a revoked delegation", async () => {
    const { assertion, exchange, tokens, account } = await setup();
    expect(await exchange(await assertion({ scope: [...SCOPES, S.courseworkStudents].join(" ") }))).toMatchObject({ status: 401, body: { error: "unauthorized_client" } });
    expect(await exchange(await assertion({ sub: "nobody@elsewhere.example" }))).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const other = await syntheticServiceAccount("other@synthetic-project.iam.gserviceaccount.com");
    expect(await exchange(await assertion({}, other.keyFile.private_key))).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    tokens.revoke(account.keyFile.client_email);
    expect(await exchange(await assertion({}))).toMatchObject({ status: 401, body: { error: "unauthorized_client" } });
  });
});
