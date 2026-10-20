// Boots both synthetic districts, each on its own local port, and prints their health.
//
//   pnpm schoolos:harness           serve until interrupted (ports 4801, 4802, ...)
//   pnpm schoolos:harness --check   boot, query every /health over HTTP, then exit
//
// SCHOOLOS_HARNESS_PORT changes the first port. With --check, ports are ephemeral.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { bootHarness, type HarnessDistrict } from "./harness.ts";

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

function serve(entry: HarnessDistrict, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "localhost"}`;
    toRequest(req, origin)
      .then((request) => entry.district.fetch(request))
      .then((response) => writeResponse(res, response))
      .catch((error: unknown) => {
        console.error(`${entry.district.districtId}: request failed`, error);
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
  const basePort = check ? 0 : Number(process.env.SCHOOLOS_HARNESS_PORT ?? 4801);
  const districts = await bootHarness();
  const servers = await Promise.all(districts.map((entry, i) => serve(entry, check ? 0 : basePort + i)));

  for (const [i, entry] of districts.entries()) {
    const { port } = servers[i]!.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(`${url}/health`);
    const health = (await response.json()) as { directory: Record<string, number> };
    const counts = Object.entries(health.directory).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${entry.district.districtId}  ${url}  health=${response.status}  ${counts}`);
    if (!check) {
      const student = entry.district.directory.principals.find((p) => p.kind === "student")!;
      const token = await entry.identity.issueToken(student.externalIdentities[0]!.subject);
      console.log(`  try: curl -H 'authorization: Bearer ${token}' ${url}/me   # ${student.displayName}`);
    }
  }

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
