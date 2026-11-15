#!/usr/bin/env node
// Opens the demo Canvas in your browser as one synthetic Northfield person (SCHO-419), to present
// their own view: their course, their submissions, their grades.
//
//   node scripts/demo/canvas-open-as.ts <principal> [path]
//   node scripts/demo/canvas-open-as.ts prn_nf-student-kofi /courses/10/grades
//
// The synthetic people have no passwords, and Canvas's Act as user is refused here: the demo
// account (3) is its own root account, while canvas.mackie.house answers as the PlayTrek root, where
// the demo administrator holds no rights and should not. So, as the acceptance scripts do, this
// mints a single-use session token for that person in the Canvas console (`canvas-actors.ts`) and
// hands the sign-in link straight to the browser. It never prints the link. The browser then is
// that person until it signs out, so use a separate browser profile, signed in to Access.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { consoleActors, railsRunner, type CanvasActors } from "./canvas-actors.ts";

const CANVAS = "https://canvas.mackie.house";

/** The one-time sign-in link for `token`, landing on `path` (a Canvas path, `/` by default). */
export function signInUrl(token: string, path = "/"): string {
  if (!/^\/(?!\/)[\w\-./?=&%]*$/.test(path)) throw new Error(`Refusing path ${JSON.stringify(path)}: give a Canvas path such as /courses/10/grades`);
  const url = new URL(path, CANVAS);
  url.searchParams.set("session_token", token);
  return url.toString();
}

/** Mints `principalId`'s session and passes the link to `open`; returns where it lands, without the token. */
export async function openAs(actors: CanvasActors, principalId: string, path: string | undefined, open: (url: string) => void): Promise<string> {
  const url = signInUrl(await actors.session(principalId), path);
  open(url);
  return `${CANVAS}${path ?? "/"}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [principalId, path] = process.argv.slice(2);
  if (principalId === undefined) {
    console.error("usage: canvas-open-as.ts <principal, e.g. prn_nf-student-kofi> [Canvas path, e.g. /courses/10/grades]");
    process.exit(2);
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  const landed = await openAs(consoleActors(railsRunner(), "educateos-demo open-as"), principalId, path,
    (url) => execFileSync(opener, [url], { stdio: "ignore" }));
  console.log(`Opened ${landed} as ${principalId}.`);
}
