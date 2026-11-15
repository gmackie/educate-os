// Boots Willow Creek, a dedicated community installation with home learning (ADR-0016), on one
// local port, seeds one family through the API (two children, a plan each, and one finished
// practice session), and prints sign-in tokens.
//
//   pnpm educateos:community           serve until interrupted (on 4810)
//   pnpm educateos:community --check   boot, seed, verify over HTTP, then exit
//
// Then run the Learning Home against it:
//   EDUCATEOS_DISTRICT_URL=http://127.0.0.1:4810 pnpm --filter @educateos/student-ui dev
// and open http://localhost:5181/?token=<a token below>.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { WILLOWCREEK } from "@educateos/fixtures";
import { demoWeb } from "./district-app.ts";
import { identityFromBearer } from "./sign-in.ts";
import { bootHarness } from "./harness.ts";

type Json = Record<string, unknown>;

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const [entry] = await bootHarness([WILLOWCREEK]);
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(WILLOWCREEK),
    verifyRequest: (request) => identityFromBearer(request, entry!.identity),
    importFetch: demoWeb,
    homeLearning: { signup: "open" },
  });
  const token = (subject: string) => entry!.identity.issueToken(subject);
  const call = async (bearer: string, method: string, path: string, body?: unknown, cookie?: string) => {
    const response = await app.fetch(new Request(`https://willowcreek.example${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return { json: (await response.json()) as Json, setCookie: response.headers.get("set-cookie") };
  };

  // Jordan Rivers' family: Maya (K) and Leo (grade 1), each with a short plan.
  const rivers = await token("wc-parent-rivers");
  await call(rivers, "POST", "/api/family/create", { name: "The Rivers family", pin: "2468" });
  const maya = (await call(rivers, "POST", "/api/family/learners", { displayName: "Maya", avatar: "🦊", gradeBand: "K" })).json;
  const leo = (await call(rivers, "POST", "/api/family/learners", { displayName: "Leo", avatar: "🐢", gradeBand: "1" })).json;
  for (const activity of ["count-to-5", "count-sounds"]) {
    await call(rivers, "POST", `/api/family/learners/${maya.id}/queue`, { pack: activity === "count-sounds" ? "reading-foundations" : "number-sense", activity });
  }
  for (const activity of ["build-words-set-1", "jump-forward-10"]) {
    await call(rivers, "POST", `/api/family/learners/${leo.id}/queue`, { pack: activity.startsWith("jump") ? "number-sense" : "reading-foundations", activity });
  }

  // Maya counts to 5 once, every answer right, as a child session on this "device".
  const started = await call(rivers, "POST", `/api/family/learners/${maya.id}/child-session`, {});
  const cookie = started.setCookie!.split(";")[0]!;
  const home = (await call(rivers, "GET", "/api/learner/home", undefined, cookie)).json as { queue: { entryId: string }[] };
  const view = (await call(rivers, "POST", `/api/learner/queue/${home.queue[0]!.entryId}/start`, {}, cookie)).json as { sessionId: string; items: { key: string; answer: number }[] };
  for (const item of view.items) {
    await call(rivers, "POST", `/api/learner/sessions/${view.sessionId}/responses`, {
      requestId: crypto.randomUUID(), item: item.key, answers: [{ kind: "number", value: item.answer }], hintUsed: false, adultHelped: false,
    }, cookie);
  }
  await call(rivers, "POST", "/api/learner/exit", { pin: "2468" }, cookie);
  const progress = (await call(rivers, "GET", `/api/family/learners/${maya.id}/progress`)).json as { sessions: { note: string }[] };

  const port = check ? 0 : Number(process.env.EDUCATEOS_COMMUNITY_PORT ?? 4810);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      app.fetch(new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`), { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) }))
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch((error: unknown) => {
          console.error("request failed", error);
          res.writeHead(500).end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`${WILLOWCREEK.district.name}  ${url}  home learning: open sign-up`);
  console.log(`  seeded: Rivers family (PIN 2468) with Maya and Leo; Maya's last session: ${progress.sessions[0]?.note}`);
  if (check) {
    const me = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${rivers}` } });
    console.log(`  /api/me as Jordan Rivers: ${me.status}`);
    server.close();
    if (me.status !== 200) process.exitCode = 1;
    return;
  }
  for (const [who, subject] of [["Jordan Rivers (family set up)", "wc-parent-rivers"], ["Priya Nair (no family yet)", "wc-parent-nair"], ["A newcomer (not joined)", "wc-newcomer"], ["Dana Okafor (organizer)", "wc-organizer"]] as const) {
    console.log(`  ${who.padEnd(32)} ?token=${await token(subject)}`);
  }
  console.log("Serving. Press Ctrl-C to stop. Tokens expire in an hour and do not survive a restart.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
