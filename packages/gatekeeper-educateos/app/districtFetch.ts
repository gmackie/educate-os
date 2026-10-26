// The School app's way to the district: each request the district API client makes goes to the
// account over the host's RPC session, never the network, which the frame has none of.
import type { SchoolAppApi } from "../src/school-app-api.ts";

/** The address the client is given. Only the path and query of its requests travel. */
export const DISTRICT_BASE_URL = "https://district.invalid";

/** A `fetch` for the district API client that sends each request through `api`. */
export const districtFetch = (api: Pick<SchoolAppApi, "request">) => async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const method = request.method === "POST" ? "POST" : "GET";
  const reply = await api.request(method, url.pathname + url.search, method === "POST" ? await request.text() : null);
  const headers = new Headers({ "content-type": "application/json" });
  if (reply.correlationId !== null) headers.set("x-correlation-id", reply.correlationId);
  return new Response(reply.status === 204 || reply.body === "" ? null : reply.body, { status: reply.status, headers });
};
