// `CF_ACCESS_AUD` as a list (SCHO-218): the district's own Access application and the instance
// Workshop's. district.test.ts checks the deployed Worker against such a list end to end.
import { describe, expect, it } from "vitest";
import { accessAudiences, accessRequestVerifier } from "../src/access.ts";

describe("the Access audiences a district accepts", () => {
  it("reads a comma-separated list, trimming entries and ignoring empty ones", () => {
    expect(accessAudiences("district-aud")).toStrictEqual(["district-aud"]);
    expect(accessAudiences(" district-aud , workshop-aud ")).toStrictEqual(["district-aud", "workshop-aud"]);
    expect(accessAudiences(",district-aud,, ,workshop-aud,")).toStrictEqual(["district-aud", "workshop-aud"]);
    expect(accessAudiences(" , ")).toStrictEqual([]);
    expect(accessAudiences(undefined)).toStrictEqual([]);
  });

  it("refuses to start without an issuer and at least one real audience", () => {
    const keys = async () => { throw new Error("unused"); };
    const issuer = "https://team.cloudflareaccess.com";
    expect(() => accessRequestVerifier({ issuer, audiences: [], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: accessAudiences(" , "), keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: ["district-aud", " "], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer: "", audiences: ["district-aud"], keys })).toThrow("must both be configured");
    expect(() => accessRequestVerifier({ issuer, audiences: ["district-aud", "workshop-aud"], keys })).not.toThrow();
  });
});
