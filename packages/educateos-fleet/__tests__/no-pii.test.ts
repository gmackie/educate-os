import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as fleet from "../src/index.ts";
import { makeDistrict, makeRegistry, manualClock } from "./support.ts";

// Words that, as part of a field name, suggest the field carries personal data. A field name is
// split into words (`contactEmail` -> contact, email) and no word may be on this list. Only the
// field's name is checked, so this complements the allow-list rather than replacing it.
const PERSONAL_WORDS = new Set([
  "address", "age", "answer", "avatar", "birth", "birthday", "body", "chat", "comment", "content",
  "conversation", "dob", "email", "essay", "first", "gender", "grade", "guardian", "ip", "location",
  "mail", "message", "name", "note", "parent", "person", "phone", "photo", "prompt", "roster",
  "score", "ssn", "student", "submission", "surname", "text", "transcript", "user", "username",
]);

function words(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/);
}

function looksPersonal(fieldName: string): boolean {
  // Plurals count too: `notes`, `emails`.
  return words(fieldName).some((word) => PERSONAL_WORDS.has(word) || PERSONAL_WORDS.has(word.replace(/s$/, "")));
}

interface WalkedObject {
  path: string;
  keys: string[];
  strict: boolean;
}

// Walks a Zod 4 schema and returns every object schema in it, with its field names and whether it
// rejects unknown keys.
function objectsIn(schema: z.ZodType, path: string, seen = new Set<z.ZodType>()): WalkedObject[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const recurse = (child: unknown, childPath: string) =>
    child instanceof z.ZodType ? objectsIn(child, childPath, seen) : [];
  switch (def.type) {
    case "object": {
      const shape = (schema as z.ZodObject).shape;
      const catchall = def.catchall as z.ZodType | undefined;
      const self = { path, keys: Object.keys(shape), strict: catchall?._zod.def.type === "never" };
      return [self, ...Object.entries(shape).flatMap(([key, child]) => recurse(child, `${path}.${key}`))];
    }
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
    case "nonoptional":
      return recurse(def.innerType, path);
    case "array":
      return recurse(def.element, `${path}[]`);
    case "pipe":
      return [...recurse(def.in, path), ...recurse(def.out, path)];
    case "union":
      return (def.options as z.ZodType[]).flatMap((option) => recurse(option, path));
    case "record":
      return [...recurse(def.keyType, `${path}{key}`), ...recurse(def.valueType, `${path}{}`)];
    default:
      // Leaves (strings, numbers, enums) and the lazy JSON payload of an envelope, whose content
      // each message schema describes on its own.
      return [];
  }
}

const exportedSchemas = Object.entries(fleet as Record<string, unknown>).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);
const exportedObjects = exportedSchemas.flatMap(([name, schema]) => objectsIn(schema, name));

describe("fleet protocol field names", () => {
  it("covers every wire message", () => {
    const names = new Set(exportedObjects.map((object) => object.path.split(".")[0]));
    for (const message of [
      "RegistrationRequest",
      "RegistrationReceipt",
      "RekeyRequest",
      "RekeyReceipt",
      "Heartbeat",
      "HealthProbe",
      "ManagementRevocation",
      "ReleaseOffer",
      "SupportSessionRequest",
      "ReleaseDecisionReport",
      "FleetViewEntry",
      "Entitlement",
      "SignedEnvelope",
    ]) {
      expect(names).toContain(message);
    }
  });

  it("flags names that look like personal data", () => {
    for (const name of ["contactEmail", "studentId", "firstName", "promptText", "phone_number", "homeAddress", "content"]) {
      expect(looksPersonal(name), name).toBe(true);
    }
    for (const name of ["instanceId", "districtLabel", "contactRole", "commercialAccountId", "probes", "sentAt"]) {
      expect(looksPersonal(name), name).toBe(false);
    }
  });

  it("contains no field whose name suggests personal data", () => {
    const offenders = exportedObjects.flatMap((object) =>
      object.keys.filter(looksPersonal).map((key) => `${object.path}.${key}`),
    );
    expect(offenders).toEqual([]);
  });

  it("is made only of strict objects, so unknown fields are rejected", () => {
    expect(exportedObjects.filter((object) => !object.strict).map((object) => object.path)).toEqual([]);
  });

  it("stores nothing at the root under a personal-looking name", async () => {
    const clock = manualClock();
    const { registry, storage } = makeRegistry(clock);
    for (const snapshot of [NORTHFIELD, RIVERBEND]) {
      const district = await makeDistrict(snapshot, clock, { sharesAggregateSpend: true });
      await registry.register(await district.registration());
      await registry.acceptHeartbeat(
        await district.agent.heartbeat({ releaseVersion: "0.1.0", probes: [], aggregateAiSpendUsdNano: "50000000" }),
      );
    }
    for (const record of await storage.list()) {
      expect(Object.keys(record).filter(looksPersonal)).toEqual([]);
    }
  });
});

describe("extra fields can't ride along", () => {
  const smuggled = { studentEmail: "student@northfield.example" };
  const samples = {
    RegistrationRequest: {
      instanceId: "ins_northfield",
      districtLabel: "Northfield Public Schools (synthetic)",
      publicKey: "A".repeat(43),
      releaseVersion: "0.1.0",
      capabilityIds: ["core-learning"],
      contactRole: "district-technology-admin",
      commercialAccountId: "acct_northfield",
      requestedAt: "2026-10-20T12:00:00Z",
    },
    Heartbeat: {
      instanceId: "ins_northfield",
      sequence: 1,
      sentAt: "2026-10-20T12:00:00Z",
      releaseVersion: "0.1.0",
      probes: [{ probeId: "d1", status: "ok" }],
    },
    ManagementRevocation: {
      instanceId: "ins_northfield",
      sequence: 2,
      sentAt: "2026-10-20T12:00:00Z",
      ownershipToken: "A".repeat(43),
    },
    ReleaseOffer: {
      instanceId: "ins_northfield",
      releaseId: "r2-fixture",
      releaseVersion: "0.2.0",
      channel: "stable",
      purpose: "upgrade",
      offerSequence: 1,
      manifestSha256: "0".repeat(64),
      signedManifest: { payload: {}, signature: "A".repeat(86), keyId: `ed25519-${"A".repeat(43)}` },
      offeredAt: "2026-10-20T12:00:00Z",
      expiresAt: "2026-10-27T12:00:00Z",
    },
    RekeyRequest: {
      instanceId: "ins_northfield",
      publicKey: "A".repeat(43),
      ownershipToken: "A".repeat(43),
      requestedAt: "2026-10-20T12:00:00Z",
    },
    ReleaseDecisionReport: {
      instanceId: "ins_northfield",
      sequence: 3,
      sentAt: "2026-10-20T12:00:00Z",
      offerSequence: 1,
      releaseId: "r2-fixture",
      decision: "declined",
      reasonCode: "maintenance-window",
    },
    SupportSessionRequest: {
      requestId: "sup_ticket-1",
      instanceId: "ins_northfield",
      reasonCode: "upgrade-assist",
      requestedAt: "2026-10-20T12:00:00Z",
      expiresAt: "2026-10-21T12:00:00Z",
    },
    Entitlement: {
      instanceId: "ins_northfield",
      revision: 1,
      capabilityIds: ["core-learning"],
      issuedAt: "2026-10-20T12:00:00Z",
      validUntil: "2026-11-20T12:00:00Z",
      graceUntil: "2026-12-20T12:00:00Z",
    },
  } as const;

  const schemas: Record<keyof typeof samples, z.ZodType> = {
    RegistrationRequest: fleet.RegistrationRequest,
    Heartbeat: fleet.Heartbeat,
    ManagementRevocation: fleet.ManagementRevocation,
    RekeyRequest: fleet.RekeyRequest,
    ReleaseDecisionReport: fleet.ReleaseDecisionReport,
    ReleaseOffer: fleet.ReleaseOffer,
    SupportSessionRequest: fleet.SupportSessionRequest,
    Entitlement: fleet.Entitlement,
  };

  for (const [name, sample] of Object.entries(samples)) {
    it(`${name} rejects an unknown field`, () => {
      const schema = schemas[name as keyof typeof samples];
      expect(schema.safeParse(sample).success).toBe(true);
      expect(schema.safeParse({ ...sample, ...smuggled }).success).toBe(false);
    });
  }

  it("a nested health probe rejects an unknown field", () => {
    const heartbeat = { ...samples.Heartbeat, probes: [{ probeId: "d1", status: "ok", ...smuggled }] };
    expect(fleet.Heartbeat.safeParse(heartbeat).success).toBe(false);
  });

  it("an envelope rejects an unknown field", () => {
    const envelope = { payload: samples.Heartbeat, signature: "A".repeat(86), keyId: `ed25519-${"A".repeat(43)}` };
    expect(fleet.SignedEnvelope.safeParse(envelope).success).toBe(true);
    expect(fleet.SignedEnvelope.safeParse({ ...envelope, ...smuggled }).success).toBe(false);
  });
});
