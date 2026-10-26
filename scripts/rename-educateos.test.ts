import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_MARKER, rename } from "./rename-educateos.ts";

test("renames SchoolOS spellings and keeps the names other systems own", () => {
  assert.equal(rename("@schoolos/config SchoolOsError SCHOOLOS_UI_BASE"), "@educateos/config EducateOsError EDUCATEOS_UI_BASE");
  assert.equal(rename("https://schoolos.gmac.io via schoolos-district-worker"), "https://schoolos.gmac.io via schoolos-district-worker");
});

test("leaves a line carrying the keep marker as it is, and only that line", () => {
  const legacy = `const LEGACY_TABLE = "schoolos_quizzes"; // ${KEEP_MARKER}: SCHO-232 reads the pre-rename table`;
  assert.equal(rename(`${legacy}\nconst TABLE = "schoolos_quizzes";`), `${legacy}\nconst TABLE = "educateos_quizzes";`);
});
