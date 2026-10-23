import { describe, expect, it } from "vitest";
import * as contracts from "@gmacko/hall-monitor-contracts";
import { MAX_TEXT_LENGTH, OpaqueId, SCHEMA_VERSION } from "../src/screening.ts";

describe("Hall Monitor contract values copied into screening", () => {
  it("match the vendored contracts package", () => {
    expect(SCHEMA_VERSION).toBe(contracts.SCHEMA_VERSION);
    expect(MAX_TEXT_LENGTH).toBe(contracts.MAX_TEXT_LENGTH);
    for (const id of ["tenant-1", "a.b:c_d-e", "x".repeat(128), "", "-leading", "has space", "x".repeat(129), "ünicode"]) {
      expect(OpaqueId.safeParse(id).success, id).toBe(contracts.OpaqueId.safeParse(id).success);
    }
  });
});
