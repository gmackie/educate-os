import { describe, expect, it } from "vitest";
import { LTI_CLAIM, LTI_SCOPES, STATE_COOKIE_BINDING } from "../src/index.ts";
import { rejection, startLogin, TOOL } from "./helpers.ts";
import { AMARA_SUB, BIO, BIO_CONTEXT, createServicesWorld } from "./services-helpers.ts";

describe("AGS line items and results", () => {
  it("creates, lists and gets line items in the context", async () => {
    const world = await createServicesWorld();
    const services = world.canvas.contextServices(BIO_CONTEXT);
    const created = await world.ags.createLineItem(services, {
      label: "Cell lab report",
      scoreMaximum: 20,
      resourceLinkId: "rl-cell-lab",
      resourceId: "act_cell-lab",
    });
    expect(created).toMatchObject({ label: "Cell lab report", scoreMaximum: 20 });
    expect(created.id.startsWith(`${world.canvas.lineItemsUrl(BIO_CONTEXT)}/`)).toBe(true);
    world.canvas.addLineItem(BIO_CONTEXT, { label: "Quiz", scoreMaximum: 5 });

    expect(await world.ags.listLineItems(services)).toHaveLength(2);
    expect(await world.ags.listLineItems(services, { resourceLinkId: "rl-cell-lab" })).toEqual([created]);
    expect(await world.ags.getLineItem(services, created.id)).toEqual(created);

    const post = world.canvas.requests.find((request) => request.method === "POST" && request.url === world.canvas.lineItemsUrl(BIO_CONTEXT));
    expect(post?.contentType).toBe("application/vnd.ims.lis.v2.lineitem+json");
  });

  it("reads results, for one user when asked", async () => {
    const world = await createServicesWorld();
    const services = world.canvas.contextServices(BIO_CONTEXT);
    const lineItem = world.canvas.addLineItem(BIO_CONTEXT, { label: "Quiz", scoreMaximum: 5 });
    world.canvas.results.set(lineItem, [
      { id: `${lineItem}/results/1`, scoreOf: lineItem, userId: AMARA_SUB, resultScore: 4, resultMaximum: 5 },
      { id: `${lineItem}/results/2`, scoreOf: lineItem, userId: "lti-user-other", resultScore: 2, resultMaximum: 5 },
    ]);
    expect(await world.ags.readResults(services, lineItem)).toHaveLength(2);
    expect(await world.ags.readResults(services, lineItem, AMARA_SUB)).toEqual([
      { id: `${lineItem}/results/1`, scoreOf: lineItem, userId: AMARA_SUB, resultScore: 4, resultMaximum: 5 },
    ]);
  });

  it("refuses a line item outside the context's container without sending the token there", async () => {
    const world = await createServicesWorld();
    const services = world.canvas.contextServices(BIO_CONTEXT);
    const otherCourse = world.canvas.addLineItem("nf-canvas-course-eng9-p3", { label: "Essay", scoreMaximum: 10 });
    expect(await rejection(world.ags.getLineItem(services, otherCourse))).toBe("forbidden");
    expect(await rejection(world.ags.getLineItem(services, "https://collector.attacker.example/line_items/1"))).toBe("forbidden");
    expect(world.fetched.filter((url) => url !== world.canvas.tokenUrl)).toEqual([]);
  });

  it("follows line item pages only within the context's container", async () => {
    const world = await createServicesWorld();
    const services = world.canvas.contextServices(BIO_CONTEXT);
    const container = world.canvas.lineItemsUrl(BIO_CONTEXT);
    world.canvas.addLineItem(BIO_CONTEXT, { label: "Quiz", scoreMaximum: 5 });
    world.canvas.lineItemsLink = (url) => (url.searchParams.get("page") === null ? `<${container}?page=2>; rel="next"` : undefined);
    expect(await world.ags.listLineItems(services)).toHaveLength(2);

    const otherCourse = world.canvas.lineItemsUrl("nf-canvas-course-eng9-p3");
    world.canvas.addLineItem("nf-canvas-course-eng9-p3", { label: "Essay", scoreMaximum: 10 });
    world.canvas.lineItemsLink = (url) => (url.pathname === new URL(container).pathname ? `<${otherCourse}>; rel="next"` : undefined);
    expect(await rejection(world.ags.listLineItems(services))).toBe("forbidden");
    expect(world.fetched).not.toContain(otherCourse);
  });

  it("refuses an operation the context's AGS claim does not grant", async () => {
    const world = await createServicesWorld();
    const readOnly = world.canvas.contextServices(BIO_CONTEXT, [LTI_SCOPES.lineItemReadonly]);
    expect(await rejection(world.ags.createLineItem(readOnly, { label: "Quiz", scoreMaximum: 5 }))).toBe("forbidden");
    expect(await rejection(world.ags.readResults(readOnly, `${world.canvas.lineItemsUrl(BIO_CONTEXT)}/1`))).toBe("forbidden");
    await expect(world.ags.listLineItems(readOnly)).resolves.toEqual([]);
    // The token asked only for what the context grants.
    expect(new URLSearchParams(world.canvas.tokenRequests[0]!.body).get("scope")).toBe(LTI_SCOPES.lineItemReadonly);
  });

  it("refuses a context the registration does not map to an offering", async () => {
    const world = await createServicesWorld();
    expect(await rejection(world.ags.listLineItems(world.canvas.contextServices("canvas-course-unmapped")))).toBe("forbidden");
  });
});

describe("LTI Advantage claims on a launch", () => {
  it("reports the context's AGS and NRPS services, and drops a malformed service claim", async () => {
    const world = await createServicesWorld();
    const platform = world.platforms.nfCanvas;
    const ags = {
      scope: [LTI_SCOPES.lineItem, LTI_SCOPES.score],
      lineitems: world.canvas.lineItemsUrl(BIO_CONTEXT),
      lineitem: `${world.canvas.lineItemsUrl(BIO_CONTEXT)}/7`,
    };
    const nrps = { context_memberships_url: world.canvas.membershipsUrl(BIO_CONTEXT), service_versions: ["2.0"] };

    const launch = async (overrides: Record<string, unknown>) => {
      const { state, nonce } = await startLogin(world, platform);
      const token = await platform.idToken({ sub: AMARA_SUB, nonce, contextId: BIO_CONTEXT, targetLinkUri: `${TOOL}/lti/launch`, overrides });
      return (await world.broker.launch(token, state, STATE_COOKIE_BINDING)).launch;
    };

    const full = await launch({ [LTI_CLAIM.agsEndpoint]: ags, [LTI_CLAIM.nrpsService]: nrps });
    expect(full.offeringId).toBe(BIO);
    expect(full.services).toEqual({
      registration: { issuer: platform.issuer, clientId: platform.clientId },
      contextId: BIO_CONTEXT,
      ags: { scopes: ags.scope, lineItemsUrl: ags.lineitems, lineItemUrl: ags.lineitem },
      nrps: { membershipsUrl: nrps.context_memberships_url },
    });

    const malformed = await launch({ [LTI_CLAIM.agsEndpoint]: { ...ags, lineitems: "http://insecure.example/x" }, [LTI_CLAIM.nrpsService]: nrps });
    expect(malformed.services).toEqual({
      registration: { issuer: platform.issuer, clientId: platform.clientId },
      contextId: BIO_CONTEXT,
      nrps: { membershipsUrl: nrps.context_memberships_url },
    });

    expect((await launch({})).services).toBeUndefined();
  });
});
