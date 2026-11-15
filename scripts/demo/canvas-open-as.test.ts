import assert from "node:assert/strict";
import { test } from "node:test";
import { openAs, signInUrl } from "./canvas-open-as.ts";
import type { CanvasActors } from "./canvas-actors.ts";

test("the sign-in link lands on the Canvas path, carrying the one-time token", () => {
  assert.equal(signInUrl("tok/+=", "/courses/10/grades"), "https://canvas.mackie.house/courses/10/grades?session_token=tok%2F%2B%3D");
  assert.equal(signInUrl("t"), "https://canvas.mackie.house/?session_token=t");
});

test("only a Canvas path is accepted, never another host", () => {
  for (const bad of ["//evil.example/x", "https://evil.example/", "courses/10", "/courses/10\n"]) {
    assert.throws(() => signInUrl("t", bad), /Refusing path/);
  }
});

test("the link goes to the browser, and only the landing page is reported", async () => {
  const opened: string[] = [];
  const actors = { session: async (id: string) => `token-for-${id}` } as unknown as CanvasActors;
  const landed = await openAs(actors, "prn_nf-student-kofi", "/courses/10/grades", (url) => opened.push(url));
  assert.deepEqual(opened, ["https://canvas.mackie.house/courses/10/grades?session_token=token-for-prn_nf-student-kofi"]);
  assert.equal(landed, "https://canvas.mackie.house/courses/10/grades");
  assert.ok(!landed.includes("token"));
});
