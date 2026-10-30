import { describe, expect, it } from "vitest";
import { DurableTokenStore, type GrantStorage, type GrantTransaction } from "../src/index.ts";

// Serial transaction harness: independently constructed adapters share the durable backing store.
function storageHarness() {
  const records = new Map<string, unknown>();
  let tail = Promise.resolve();
  const storage: GrantStorage = {
    async get<T>(key: string) {
      return structuredClone(records.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      records.set(key, structuredClone(value));
    },
    async delete(key) {
      return records.delete(key);
    },
    transaction<T>(callback: (tx: GrantTransaction) => Promise<T>): Promise<T> {
      const next = tail.then(() => callback(storage));
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  };
  return { storage, records };
}

describe("durable token store", () => {
  it("claims an assertion once across adapter instances and keeps issuers isolated", async () => {
    const { storage, records } = storageHarness();
    const first = new DurableTokenStore(storage);
    const second = new DurableTokenStore(storage);
    const key = JSON.stringify(["https://issuer.example", "same-jti"]);
    expect(
      (await Promise.all([first.claimAssertion(key, 123), second.claimAssertion(key, 123)])).toSorted(),
    ).toEqual([false, true]);
    expect(
      await second.claimAssertion(JSON.stringify(["https://other.example", "same-jti"]), 123),
    ).toBe(true);
    expect([...records.keys()].every((name) => /^mcp:assertion:[a-f0-9]{64}$/.test(name))).toBe(
      true,
    );
  });
  it("persists grants across adapters and revokes them immediately", async () => {
    const { storage } = storageHarness();
    const first = new DurableTokenStore(storage);
    const second = new DurableTokenStore(storage);
    const grant = {
      identity: {
        issuer: "https://issuer.example",
        subject: "student",
        credential: "person" as const,
      },
      expiresAt: 123,
    };
    await first.putAccess("digest", grant);
    expect(await second.getAccess("digest")).toEqual(grant);
    await second.revokeAccess("digest");
    expect(await first.getAccess("digest")).toBeUndefined();
  });
});
