// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import { fakeDistrict } from "../testing/fakeDistrict.ts";
import { renderConsole } from "../testing/renderConsole.tsx";

describe("MCP & AI access management console", () => {
  it("shows the endpoint URL, client guides, approval queue, tokens, delegations, and tool catalog", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "mcp");

    expect(await screen.findByText("https://educateos.fake.example/mcp")).toBeTruthy();
    expect(screen.getByText(/Built-in Cloudflare OAuth/)).toBeTruthy();
    expect(screen.getByText(/57 tools across/)).toBeTruthy();

    // Switch client setup tabs (Claude Code / Bearer token / CLI).
    await user.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(screen.getByText(/claude mcp add --transport http educateos/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Bearer token / CLI" }));
    expect(screen.getByText(/Bearer edum_/)).toBeTruthy();

    // Pending approval is visible and can be approved through HTTP.
    const approvalRegion = screen.getByRole("region", { name: /Approval queue \(1\)/ });
    expect(within(approvalRegion).getByText("create_announcement")).toBeTruthy();
    await user.click(within(approvalRegion).getByRole("button", { name: "Approve and apply" }));
    await waitFor(() => expect(district.calls.some((c) => c.name === "teacher.approveToolAction")).toBe(true));
    expect(await screen.findByText(/No queued MCP writes are waiting for review right now/)).toBeTruthy();
  });

  it("mints a scoped personal bearer token, displays the secret once, and lets the admin revoke it", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "mcp");

    const labelInput = await screen.findByLabelText("Token label");
    await user.type(labelInput, "Curriculum sync CLI");
    await user.click(screen.getByRole("button", { name: "Mint scoped token" }));

    expect(await screen.findByText(/Token "Curriculum sync CLI" created/)).toBeTruthy();
    expect(screen.getByText(/^edum_a+$/)).toBeTruthy();
    expect(district.calls.some((c) => c.name === "teacher.createMcpToken")).toBe(true);

    // The new token appears in the tokens table and can be revoked.
    const tokensTable = screen.getByRole("table", { name: "Scoped personal MCP bearer tokens" });
    expect(within(tokensTable).getByText("Curriculum sync CLI")).toBeTruthy();
    await user.click(within(tokensTable).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(district.calls.some((c) => c.name === "teacher.revokeMcpToken")).toBe(true));
  });

  it("revokes an active OAuth client delegation and filters the LMS tool catalog by domain", async () => {
    const district = fakeDistrict();
    const { user } = renderConsole(district.client, "mcp");

    const delegationsTable = await screen.findByRole("table", { name: "MCP delegations" });
    expect(within(delegationsTable).getByText("mcpc_claude-desktop")).toBeTruthy();
    await user.click(within(delegationsTable).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(district.calls.some((c) => c.name === "teacher.revokeDelegation")).toBe(true));

    // Filter tool catalog by domain.
    const filter = screen.getByLabelText("Domain");
    await user.selectOptions(filter, "Assignments & Gradebook");
    expect(screen.getByText("propose_grade")).toBeTruthy();
    expect(screen.queryByText("create_module")).toBeNull();
  });
});
