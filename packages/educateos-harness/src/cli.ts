// Boots both synthetic districts, each on its own local port with the full district application
// (`/api/...`) seeded with demo content, and prints their health, demo sign-in tokens and where
// Morgan Lee (one IdP subject in both districts) lands in each.
//
//   pnpm educateos:harness           serve until interrupted (ports 4801, 4802, ...)
//   pnpm educateos:harness --check   boot, query every /health and /api/admin/health over HTTP, then exit
//
// EDUCATEOS_HARNESS_PORT changes the first port. With --check, ports are ephemeral.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { bootDistrictApp, harnessFetch, seedDemo } from "./district-app.ts";
import { bootHarness } from "./harness.ts";
import { MORGAN_LEE_SUBJECT, signInAcrossDistricts } from "./scenarios.ts";

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function serve(districtId: string, handle: (request: Request) => Promise<Response>, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "localhost"}`;
    toRequest(req, origin)
      .then(handle)
      .then((response) => writeResponse(res, response))
      .catch((error: unknown) => {
        console.error(`${districtId}: request failed`, error);
        res.writeHead(500).end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const basePort = check ? 0 : Number(process.env.EDUCATEOS_HARNESS_PORT ?? 4801);
  const districts = await Promise.all((await bootHarness()).map(async (entry) => {
    const app = await bootDistrictApp(entry);
    return { entry, app, demo: await seedDemo(entry, app) };
  }));
  const servers = await Promise.all(districts.map(({ entry, app }, i) =>
    serve(entry.district.districtId, harnessFetch(entry, app), check ? 0 : basePort + i)));

  for (const [i, { entry, demo }] of districts.entries()) {
    const { port } = servers[i]!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(`${url}/health`);
    const health = (await response.json()) as { directory: Record<string, number> };
    const counts = Object.entries(health.directory).map(([k, v]) => `${k}=${v}`).join(" ");
    const tokens = {
      student: await entry.identity.issueToken(demo.student.externalIdentities[0]!.subject),
      teacher: await entry.identity.issueToken(demo.teacher.externalIdentities[0]!.subject),
      admin: await entry.identity.issueToken(demo.admin.externalIdentities[0]!.subject),
    };
    const app = await fetch(`${url}/api/admin/health`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    const work = ((await app.json()) as { work?: Record<string, number> }).work ?? {};
    const seeded = Object.entries(work).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${entry.district.districtId}  ${url}  health=${response.status}  ${counts}`);
    console.log(`  app=${app.status}  ${seeded}`);
    if (!check) {
      for (const role of ["student", "teacher", "admin"] as const) {
        console.log(`  ${role.padEnd(7)} ${demo[role].displayName.padEnd(18)} curl -H 'authorization: Bearer ${tokens[role]}' ${url}/api/me`);
      }
    }
  }

  // The same teacher, signed in at each district through its own IdP, is a different principal there.
  const morgan = await signInAcrossDistricts(districts.map(({ entry }) => entry), MORGAN_LEE_SUBJECT);
  console.log(`${morgan[0]?.displayName ?? MORGAN_LEE_SUBJECT}: ${morgan.map((s) => `${s.districtId} -> ${s.principalId} (foreign tokens refused: ${s.foreignTokensRefused})`).join("; ")}`);

  if (check) {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    return;
  }
  console.log("Serving. Press Ctrl-C to stop. Tokens expire in an hour and do not survive a restart.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
