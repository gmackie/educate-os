import { describe, expect, it } from "vitest";
import { compileDesiredState, DistrictInstallConfig, loadPinnedManifest } from "../src/index.ts";
import { configFor, deriveRelease, goldenRelease, NORTHFIELD } from "./support.ts";

describe("release manifest", () => {
  it("accepts the release pipeline's golden manifest against the root's signed statement", async () => {
    const release = await goldenRelease();
    expect(Object.keys(release.manifest.workers)).toContain("workshop-backend");
  });

  it("rejects bytes that do not match the signed digest", async () => {
    const release = await goldenRelease();
    const tampered = new TextEncoder().encode(new TextDecoder().decode(release.bytes).replace("server.js", "evil.js"));
    await expect(loadPinnedManifest(tampered, configFor(NORTHFIELD, release).release, { signedManifest: release.signedManifest }))
      .rejects.toMatchObject({ code: "validation-failed", message: expect.stringContaining("SHA-256") });
  });

  it("rejects a manifest with fields or a version this installer does not know", async () => {
    const release = await goldenRelease();
    await expect(deriveRelease(release, "r1-extra", (m) => {
      (m as Record<string, unknown>).hooks = [];
    })).rejects.toMatchObject({ code: "validation-failed" });
    await expect(deriveRelease(release, "r1-v2", (m) => {
      (m as { manifestVersion: number }).manifestVersion = 2;
    })).rejects.toMatchObject({ code: "validation-failed" });
  });
});

describe("desired state", () => {
  it("orders every resource after its dependencies", async () => {
    const release = await goldenRelease();
    const desired = compileDesiredState(release.manifest, configFor(NORTHFIELD, release));
    const position = new Map(desired.resources.map((r, i) => [r.key, i]));
    for (const resource of desired.resources) {
      for (const dep of resource.dependsOn) expect(position.get(dep)).toBeLessThan(position.get(resource.key)!);
    }
    const order = desired.resources.map((r) => r.key);
    expect(order.indexOf("access:application")).toBeLessThan(order.indexOf("worker:workshop-backend"));
    expect(order.indexOf("worker:workshop-backend")).toBeLessThan(order.indexOf("worker:router"));
    expect(order.at(-1)).toBe("domain:public");
  });

  it("names every resource inside the instance's prefix", async () => {
    const release = await goldenRelease();
    const desired = compileDesiredState(release.manifest, configFor(NORTHFIELD, release));
    for (const resource of desired.resources) {
      const name = "title" in resource ? resource.title
        : "scriptName" in resource ? resource.scriptName
        : "name" in resource ? resource.name
        : "gatewayId" in resource ? resource.gatewayId
        : "spec" in resource ? resource.spec.name
        : undefined;
      expect(name ?? resource.key).toMatch(/^(schoolos-northfield(-|$)|access:|domain:)/);
    }
  });

  it("installs preinstalled and chosen gatekeepers only, and refuses ones it cannot configure", async () => {
    const release = await goldenRelease();
    const workers = (gatekeepers: string[]) =>
      compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { gatekeepers }))
        .resources.flatMap((r) => (r.kind === "worker_script" ? [r.pkgName] : [])).toSorted();
    expect(workers([])).toEqual(["gatekeeper-context", "gatekeeper-scheduler", "gatekeeper-websearch", "router", "workshop-backend"]);
    expect(() => workers(["gatekeeper-email"])).toThrow(/not installable/);
    expect(() => workers(["gatekeeper-nonexistent"])).toThrow(/no gatekeeper/);
  });

  it("renders the non-secret deploy inputs the config supplies, and keeps secrets out of it", async () => {
    const golden = await goldenRelease();
    const release = await deriveRelease(golden, "r1-inputs", (m) => {
      m.workers["gatekeeper-google"]!.inputs!.push(
        { name: "WORKSPACE_DOMAIN", kind: "var", label: "Google Workspace domain" },
        { name: "AUDIT_WORKER", kind: "workerName", label: "Audit Worker" },
      );
    });
    const compile = (gatekeeperInputs: Record<string, Record<string, string>>, gatekeepers = ["gatekeeper-google"]) =>
      compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { gatekeepers, gatekeeperInputs }));
    const inputs = { WORKSPACE_DOMAIN: "$PUBLIC_BASE_URL northfield.example", AUDIT_WORKER: "northfield-audit" };

    const google = compile({ "gatekeeper-google": inputs }).resources.find((r) => r.key === "worker:gatekeeper-google");
    expect(google?.kind === "worker_script" && google.bindings).toEqual(expect.arrayContaining([
      // Operator values are literal; a `$` in one is never read as a placeholder.
      { type: "plain_text", name: "WORKSPACE_DOMAIN", text: "$PUBLIC_BASE_URL northfield.example" },
      { type: "plain_text", name: "AUDIT_WORKER", text: "northfield-audit" },
    ]));

    expect(() => compile({})).toThrow(/needs a value for WORKSPACE_DOMAIN \(Google Workspace domain\)/);
    expect(() => compile({ "gatekeeper-google": { ...inputs, CLIENT_SECRET: "synthetic-secret" } })).toThrow(/CLIENT_SECRET is a secret/);
    expect(() => compile({ "gatekeeper-google": { ...inputs, WORKSPACE_DOMIAN: "typo" } })).toThrow(/declares no deploy input WORKSPACE_DOMIAN/);
    expect(() => compile({ "gatekeeper-google": { ...inputs, AUDIT_WORKER: "Not A Worker" } })).toThrow(/AUDIT_WORKER must be a Worker name/);
    expect(() => compile({ "gatekeeper-google": inputs, "gatekeeper-slack": { X: "y" } })).toThrow(/gatekeeper-slack, which this install does not include/);
  });

  it("refuses an input that would replace a var the release sets", async () => {
    const golden = await goldenRelease();
    const release = await deriveRelease(golden, "r1-clash", (m) => {
      m.workers["gatekeeper-google"]!.inputs!.push({ name: "BASE_URL", kind: "var", label: "Base URL" });
    });
    const config = configFor(NORTHFIELD, release, { gatekeeperInputs: { "gatekeeper-google": { BASE_URL: "https://elsewhere.example" } } });
    expect(() => compileDesiredState(release.manifest, config)).toThrow(/BASE_URL would replace a var/);
  });

  it("fails on a placeholder outside the manifest's closed vocabulary", async () => {
    const release = await goldenRelease();
    const odd = await deriveRelease(release, "r1-odd", (m) => {
      m.workers.router!.vars.UPSTREAM = "$ZONE_ID";
    });
    expect(() => compileDesiredState(odd.manifest, configFor(NORTHFIELD, odd))).toThrow(/unknown placeholder \$ZONE_ID/);
  });

  it("rejects instance IDs too long to fit Cloudflare's Worker name limit", async () => {
    const release = await goldenRelease();
    expect(() => configFor(NORTHFIELD, release, { instanceId: "ins_northfield-public-schools" })).toThrow();
    expect(DistrictInstallConfig.safeParse({ ...configFor(NORTHFIELD, release), surprise: true }).success).toBe(false);
  });
});
