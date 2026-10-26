import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO_DISTRICTS, googleDemoPlan } from "../../packages/educateos-fixtures/src/index.ts";
import { DOMAIN, TEST_ACCOUNTS, keychainAddCommand, keychainService, orgUnitUrlPath, randomPassword, rosterChanges } from "./seed-google-demo.ts";

test("passwords are long, random and safe to pass to `security -i` unquoted", () => {
  const passwords = Array.from({ length: 50 }, randomPassword);
  assert.equal(new Set(passwords).size, 50);
  for (const password of passwords) assert.match(password, /^[A-Za-z0-9]{24}$/);
  assert.doesNotThrow(() => keychainAddCommand("educateos-gedu-demo-hb-student-nia", `hb-student-nia@${DOMAIN}`, passwords[0]!));
});

test("the Keychain command refuses any value that would need quoting", () => {
  assert.throws(() => keychainAddCommand("svc", "a@b.example", 'pw" -s other'));
  assert.throws(() => keychainAddCommand("svc name", "a@b.example", "pw"));
  assert.equal(
    keychainAddCommand("educateos-gedu-demo-x", "x@d.example", "Pw1"),
    'add-generic-password -U -s "educateos-gedu-demo-x" -a "x@d.example" -l "educateos-gedu-demo-x" -w "Pw1"\n',
  );
});

test("test accounts are three planned accounts, each with its own Keychain service", () => {
  const plan = googleDemoPlan(DOMAIN, DEMO_DISTRICTS);
  const services = TEST_ACCOUNTS.map((id) => keychainService(plan.users.find((u) => u.fixtureId === id)!.primaryEmail));
  assert.deepEqual(services, [
    "educateos-gedu-demo-hb-teacher-asante",
    "educateos-gedu-demo-hb-student-nia",
    "educateos-gedu-demo-cv-teacher-whitaker",
  ]);
});

test("org unit paths become URL segments", () => {
  assert.equal(orgUnitUrlPath("/Harbor/Staff"), "Harbor/Staff");
  assert.equal(orgUnitUrlPath("/CedarValley"), "CedarValley");
});

test("roster changes add what is missing and remove what is extra", () => {
  assert.deepEqual(rosterChanges(["a", "b", "c"], ["b", "d"]), { add: ["a", "c"], remove: ["d"] });
  assert.deepEqual(rosterChanges(["a"], ["a"]), { add: [], remove: [] });
});
