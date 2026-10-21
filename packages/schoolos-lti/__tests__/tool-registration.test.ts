import { describe, expect, it } from "vitest";
import { InMemoryToolRegistrationStore, matchToolRegistration, ToolRegistration } from "../src/index.ts";

const base = {
  id: "ltr_sim-co",
  districtId: "dst_northfield",
  name: "Simulation Co (synthetic)",
  domains: ["sim.tools.example"],
  clientId: "client-1",
  deploymentId: "deployment-1",
  oidcLoginUrl: "https://sim.tools.example/lti/login",
  jwksUrl: "https://sim.tools.example/lti/jwks",
  status: "approved",
  approvedBy: "prn_nf-district-admin",
  approvedAt: "2026-10-01T09:00:00Z",
};

describe("tool registrations", () => {
  it("accept only exact lowercase hosts and https endpoints", () => {
    for (const domains of [["*.tools.example"], ["SIM.tools.example"], ["sim.tools.example:443"], ["localhost"], []]) {
      expect(ToolRegistration.safeParse({ ...base, domains }).success, JSON.stringify(domains)).toBe(false);
    }
    expect(ToolRegistration.safeParse({ ...base, oidcLoginUrl: "http://sim.tools.example/lti/login" }).success).toBe(false);
    expect(() => new InMemoryToolRegistrationStore([base, base])).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("match a launch URL by its exact host, case and trailing dot aside, over https on the default port only", () => {
    const registrations = [ToolRegistration.parse(base)];
    expect(matchToolRegistration(registrations, "https://SIM.tools.example./launch")).toMatchObject({ ok: true });
    for (const [url, reason] of [
      ["https://evil.sim.tools.example/launch", "no-registration"],
      ["https://sim.tools.example.evil.example/launch", "no-registration"],
      ["https://sim.tools.example:8443/launch", "insecure-launch-url"],
      ["https://user@sim.tools.example/launch", "insecure-launch-url"],
      ["http://sim.tools.example/launch", "insecure-launch-url"],
      ["not a url", "insecure-launch-url"],
    ] as const) {
      expect(matchToolRegistration(registrations, url), url).toStrictEqual({ ok: false, reason });
    }
  });
});
