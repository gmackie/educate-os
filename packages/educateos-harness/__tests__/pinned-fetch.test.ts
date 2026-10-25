import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { InMemoryAcademicStore } from "@educateos/academics";
import { ContentStudio, InMemoryContentStudioStorage } from "@educateos/content-studio";
import { DistrictDirectorySnapshot, DistrictId, type PolicySettings, PrincipalId } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import { describe, expect, it } from "vitest";
import { createPinnedEgressFetch, httpsTransport, type PinnedRequest, type ResolveHost } from "../src/pinned-fetch.ts";

const answers = (...addresses: string[]): ResolveHost => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

/** A transport that records what it was asked to send and answers 200. */
function recordingTransport() {
  const sent: PinnedRequest[] = [];
  const transport = async (request: PinnedRequest) => {
    sent.push(request);
    return new Response("<!doctype html><html lang=\"en\"><title>ok</title></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  return { sent, transport };
}

/** The district's policy engine over Northfield's directory, under the conservative policy floor. */
function northfieldPolicy(): PolicyEngine {
  const floor: PolicySettings = {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 500,
  };
  const store = InMemoryAcademicStore.seeded(DistrictDirectorySnapshot.parse(NORTHFIELD));
  return new PolicyEngine({ information: directoryPolicyInformation(store, { effectivePolicy: async () => floor }), audit: new InMemoryPolicyAuditSink() });
}

describe("createPinnedEgressFetch", () => {
  it("connects to the address it checked, with SNI and Host set to the name", async () => {
    const { sent, transport } = recordingTransport();
    const fetch = createPinnedEgressFetch({ resolve: answers("93.184.216.34", "2606:2800:220:1::1"), transport });
    const response = await fetch("https://open-lessons.example/cells?unit=2", { method: "GET", headers: { accept: "text/html", host: "evil.example" } });
    expect(response.status).toBe(200);
    expect(sent).toStrictEqual([{
      address: "93.184.216.34",
      port: 443,
      servername: "open-lessons.example",
      host: "open-lessons.example",
      method: "GET",
      path: "/cells?unit=2",
      headers: { accept: "text/html" },
      signal: undefined,
    }]);
  });

  it("refuses a public name that resolves to a private address, before connecting", async () => {
    for (const resolved of [["127.0.0.1"], ["169.254.169.254"], ["::ffff:10.0.0.1"], ["93.184.216.34", "10.0.0.1"]]) {
      const { sent, transport } = recordingTransport();
      const fetch = createPinnedEgressFetch({ resolve: answers(...resolved), transport });
      await expect(fetch("https://rebinding.example/", { method: "GET" })).rejects.toMatchObject({ code: "policy-violation" });
      expect(sent).toHaveLength(0);
    }
  });

  it("refuses what the studio's URL checks refuse without resolving it, and reports a name that does not resolve", async () => {
    let resolved = 0;
    const counting: ResolveHost = async () => (resolved++, []);
    const fetch = createPinnedEgressFetch({ resolve: counting, transport: recordingTransport().transport });
    for (const url of ["http://open-lessons.example/", "https://127.0.0.1/", "https://metadata.google.internal/", "https://open-lessons.example:8443/"]) {
      await expect(fetch(url, { method: "GET" })).rejects.toMatchObject({ code: "policy-violation" });
    }
    expect(resolved).toBe(0);
    await expect(fetch("https://open-lessons.example/", { method: "GET" })).rejects.toMatchObject({ code: "unavailable" });
    const failing = createPinnedEgressFetch({ resolve: async () => Promise.reject(new Error("ENOTFOUND")), transport: recordingTransport().transport });
    await expect(failing("https://open-lessons.example/", { method: "GET" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("makes the Content Studio refuse the import, and record nothing", async () => {
    const D = DistrictId.parse("dst_northfield");
    const storage = new InMemoryContentStudioStorage();
    const studio = new ContentStudio({
      districtId: D,
      storage,
      authorizer: northfieldPolicy(),
      fetch: createPinnedEgressFetch({ resolve: answers("10.1.2.3"), transport: recordingTransport().transport }),
      scanner: undefined,
      alignments: { resolve: async () => undefined },
    });
    const morgan = { principalId: PrincipalId.parse("prn_nf-morgan-lee"), districtId: D };
    const bio = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" };
    await expect(studio.submitUrl(morgan, { url: "https://intranet-wiki.example/", targetScope: bio })).rejects.toMatchObject({ code: "policy-violation" });
    expect(await storage.listItems()).toStrictEqual([]);
  });
});

/** A self-signed certificate for `pinned.example`, made for this run, or undefined without openssl. */
function testCertificate(): { cert: string; key: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "pinned-fetch-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=pinned.example", "-addext", "subjectAltName=DNS:pinned.example",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = testCertificate();

/** An HTTPS server for `pinned.example` on a loopback port, recording the SNI and Host of each request. */
async function server() {
  const seen: { servername: string | false | null; host: string | undefined }[] = [];
  const https = createServer({ ...certificate! }, (req, res) => {
    seen.push({ servername: (req.socket as TLSSocket).servername, host: req.headers.host });
    res.writeHead(302, { location: "https://pinned.example/next" }).end();
  });
  await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
  return { seen, port: (https.address() as AddressInfo).port, close: () => new Promise((resolve) => https.close(resolve)) };
}

const request = (port: number, servername: string): PinnedRequest => ({
  address: "127.0.0.1",
  port,
  servername,
  host: servername,
  method: "GET",
  path: "/start",
  headers: {},
  signal: undefined,
});

describe.skipIf(certificate === undefined)("httpsTransport", () => {
  it("connects to the pinned address, sends SNI and Host, verifies the certificate against the name and returns redirects unfollowed", async () => {
    const { seen, port, close } = await server();
    try {
      const response = await httpsTransport({ ca: certificate!.cert })(request(port, "pinned.example"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://pinned.example/next");
      expect(seen).toStrictEqual([{ servername: "pinned.example", host: "pinned.example" }]);
    } finally {
      await close();
    }
  });

  it("refuses a certificate that does not name the host", async () => {
    const { seen, port, close } = await server();
    try {
      await expect(httpsTransport({ ca: certificate!.cert })(request(port, "other.example"))).rejects.toThrow(/altnames|certificate/i);
      expect(seen).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
