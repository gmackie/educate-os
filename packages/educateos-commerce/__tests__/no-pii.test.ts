import { type DistrictDirectorySnapshot, usdNanoFromCents } from "@educateos/contracts";
import { NORTHFIELD, RIVERBEND } from "@educateos/fixtures";
import { DistrictAgent, InMemorySequenceCounter, SigningIdentity } from "@educateos/fleet";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as commerce from "../src/index.ts";
import { CLERK, DAY, idsFor, setup, TERM_START } from "./support.ts";

// The same field-name check R01 applies to the fleet protocol. A field name is split into words
// (`contactEmail` -> contact, email) and no word may suggest personal data.
const PERSONAL_WORDS = new Set([
  "address", "age", "answer", "avatar", "birth", "birthday", "body", "chat", "comment", "content",
  "conversation", "dob", "email", "essay", "first", "gender", "grade", "guardian", "ip", "location",
  "mail", "message", "name", "note", "parent", "person", "phone", "photo", "prompt", "roster",
  "score", "ssn", "student", "submission", "surname", "text", "transcript", "user", "username",
  // Commerce-specific: a billing record must not grow a payer's personal details.
  "card", "holder", "billing", "contact", "learner", "pupil",
]);
// Contacts are allowed as opaque references only.
const ALLOWED_FIELDS = new Set(["contactRefs"]);

// Words that would mean a district's Cloudflare costs had entered a EducateOS commercial record.
const INFRASTRUCTURE_WORDS = new Set(["cloudflare", "workers", "d1", "r2", "kv", "infrastructure", "hosting", "wrangler"]);

function words(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/);
}

const hasWord = (list: Set<string>) => (fieldName: string) =>
  !ALLOWED_FIELDS.has(fieldName) && words(fieldName).some((word) => list.has(word) || list.has(word.replace(/s$/, "")));
const looksPersonal = hasWord(PERSONAL_WORDS);
const looksLikeInfrastructure = hasWord(INFRASTRUCTURE_WORDS);

interface WalkedObject {
  path: string;
  keys: string[];
  strict: boolean;
}

// Walks a Zod 4 schema and returns every object schema in it, as R01's walk does.
function objectsIn(schema: z.ZodType, path: string, seen = new Set<z.ZodType>()): WalkedObject[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const recurse = (child: unknown, childPath: string) => (child instanceof z.ZodType ? objectsIn(child, childPath, seen) : []);
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
      return [];
  }
}

const exportedSchemas = Object.entries(commerce as Record<string, unknown>).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);
const exportedObjects = exportedSchemas.flatMap(([name, schema]) => objectsIn(schema, name));

/** Every key anywhere in a JSON value. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...keysIn(item)]);
  return [];
}

/** Every string in a district's directory that identifies or describes a person. */
function personalStrings(snapshot: DistrictDirectorySnapshot): string[] {
  return snapshot.principals.flatMap((principal) => [
    principal.id,
    principal.displayName,
    ...(principal.email === undefined ? [] : [principal.email]),
    ...principal.externalIdentities.map((link) => link.subject),
  ]);
}

describe("commerce record schemas", () => {
  it("cover every commerce record and request", () => {
    const names = new Set(exportedObjects.map((object) => object.path.split(".")[0]));
    for (const record of [
      "CommercialAccount", "Plan", "Subscription", "PurchaseOrder", "Invoice", "InvoiceLine", "Payment", "Grant",
      "CreditEntry", "FinanceAuditEvent", "ProcessorEvent", "IssueInvoiceRequest", "OpenAccountRequest",
    ]) {
      expect(names).toContain(record);
    }
  });

  it("flag names that look like personal data", () => {
    for (const name of ["contactEmail", "studentCount", "cardholderName", "billingAddress", "learnerIds", "parentPhone"]) {
      expect(looksPersonal(name), name).toBe(true);
    }
    for (const name of ["accountId", "districtLabel", "contactRefs", "poNumber", "enrollmentBand", "amountCents"]) {
      expect(looksPersonal(name), name).toBe(false);
    }
  });

  it("contain no field whose name suggests personal data", () => {
    const offenders = exportedObjects.flatMap((object) => object.keys.filter(looksPersonal).map((key) => `${object.path}.${key}`));
    expect(offenders).toEqual([]);
  });

  it("contain no field for the district's Cloudflare costs", () => {
    const offenders = exportedObjects.flatMap((object) => object.keys.filter(looksLikeInfrastructure).map((key) => `${object.path}.${key}`));
    expect(offenders).toEqual([]);
  });

  it("are strict objects, so unknown fields are rejected", () => {
    expect(exportedObjects.filter((object) => !object.strict).map((object) => object.path)).toEqual([]);
  });
});

describe("no per-student data enters commerce records", () => {
  it("stores nothing personal for two districts through a full lifecycle, including opted-in AI usage", async () => {
    for (const snapshot of [NORTHFIELD, RIVERBEND]) {
      const { service, store, accountId, instanceId, clock, subscribe } = await setup({ snapshot, aiUsageSharing: "opted-in" });
      const subscription = await subscribe();
      await service.activate(subscription.subscriptionId, CLERK);
      const agent = new DistrictAgent({
        identity: await SigningIdentity.generate(),
        instanceId,
        sequence: new InMemorySequenceCounter(),
        sharesAggregateSpend: true,
        now: clock.now,
      });
      const signed = await agent.heartbeat({ releaseVersion: "0.1.0", probes: [], aggregateAiSpendUsdNano: usdNanoFromCents(75_000) });
      const invoice = await service.issueInvoice(
        {
          accountId,
          subscriptionId: subscription.subscriptionId,
          lines: [{ kind: "plan-fee", code: "pilot-term", quantity: 1, unitAmountCents: 250_000 }],
          aiUsageHeartbeat: signed.payload as never,
          dueAt: new Date(Date.parse(TERM_START) + 30 * DAY).toISOString(),
        },
        CLERK,
      );
      await service.recordManualPayment(invoice.invoiceId, invoice.totalCents, "check-1", CLERK);
      await service.issueEntitlement(subscription.subscriptionId, instanceId, CLERK);

      const stored = store.dump();
      expect(keysIn(stored).filter(looksPersonal)).toEqual([]);
      const serialized = JSON.stringify(stored);
      for (const value of personalStrings(snapshot)) expect(serialized, value).not.toContain(value);
      expect(idsFor(snapshot).accountId).toBe(accountId);
    }
  });
});
