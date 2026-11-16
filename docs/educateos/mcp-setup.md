# Setting up MCP

- Audience: district IT, after `npx launch-educate-os` has installed EducateOS.
- Status: the commands are built and tested against simulated endpoints and Cloudflare (SCHO-407).
  None of the steps below has been run against a live district yet; each section says what is proven.
- Commands: `npx launch-educate-os mcp status | clients | add` ([launch-installer.md](launch-installer.md#mcp-setup-scho-407)
  has how they work).

MCP (the Model Context Protocol) is how AI tools reach outside services. EducateOS uses it two ways,
and they are set up separately:

| | Your district's MCP endpoint | The Workshop's MCP connectors |
| --- | --- | --- |
| Direction | Outside AI clients call **your district** | **Workshop agents** call outside MCP servers |
| Who uses it | Staff, from Claude, ChatGPT, Claude Code, VS Code, Cursor | District administrators connect servers; agents and Gadgets are granted them |
| Where it lives | The district Worker's `/mcp`, turned on by `DISTRICT_CONFIG.mcp` | `gatekeeper-mcp` (MCP Server) and `gatekeeper-mcp-portal` (MCP Server Portal) |
| Sign-in | OAuth tokens from the district's authorization server, not Cloudflare Access | Each server's own sign-in (OAuth), or none |
| Proven | Harness-tested; not deployed (NATH-6) | Unit-tested in Cloudflare OS; not yet used by a district |

Start with `npx launch-educate-os mcp status` in the directory holding `educateos-install.json`. It
reports both sides and checks the endpoint live. Set `CLOUDFLARE_API_TOKEN` to also check the
connectors' Workers in your account.

## 1. Add an MCP server to the AI Workshop

```sh
npx launch-educate-os mcp add --server-url https://mcp.example.org/mcp
```

1. **It checks the server** the way the Workshop's MCP Server connector will connect: an MCP
   `initialize` with no credentials. A server that answers needs no sign-in. A server that answers
   401 is followed to its OAuth metadata (RFC 9728) and its authorization server's (RFC 8414). The
   connector registers itself (dynamic client registration, RFC 7591) and signs in with PKCE, so a
   server without registration fails here: reach it through a portal configured with a token
   instead. An `http://`, private, loopback or cloud-metadata address is refused, as the Workshop
   refuses it. The check runs from your machine; the Workshop connects from Cloudflare, so a server
   only your network can reach will still fail there.
2. **It changes the answers file**, after showing the changes and asking (`--yes` without a terminal):
   - `gatekeepers` gains `gatekeeper-mcp`, which installs the MCP Server connector's Worker.
   - On an install with the district LMS, `DISTRICT_CONFIG.workshopPolicy.connectors` gains
     `{"vendorId": "mcp", "access": "all"}`. The district decides every Workshop capability, and this
     grant lets **district administrators** connect MCP servers. Teachers can't: `teacherConnectors`
     is for connectors confined to a teacher's own teaching, and an arbitrary server isn't. If
     `DISTRICT_CONFIG` has no `workshopPolicy` at all, the district refuses every Workshop capability;
     the launcher reports that and leaves it to you to write one.
3. **Apply the answers**: `npx launch-educate-os plan --config educateos-install.json` to review, then
   `npx launch-educate-os --config educateos-install.json`. Like `upgrade`, this installs the newest
   release; pass `--release <id>` to stay on yours.
4. **In the Workshop** (`https://<your hostname>/ai/`):
   1. `admin?tab=gatekeepers`: check **MCP Server** is on. Connectors are on unless an administrator
      turned them off, and this is where you turn one off for everyone.
   2. As a district administrator, open `gatekeepers` (Connectors), choose **MCP Server**, **Connect**,
      paste the server's address and sign in at the server if it asks. The address is fixed at
      connect; reconnecting can't point the account at another server.
   3. Grant it to an agent or Gadget: **All tools**, or **Choose tools** to allow only the ones you
      tick. Tools added later are refused under **Choose tools**.
5. **Check**: `npx launch-educate-os mcp status`.

Approvals are fixed by the connector, not configured: tools the server marks read-only run at once
and are recorded; every other call, including tools with no marking, waits for a person to approve
it. Nothing a pasted server claims can make a write skip approval. A Gadget bound to an MCP server
can be opened only by its owner.

### The MCP Server Portal

The portal connector reaches every server behind one portal, typically a Cloudflare MCP server
portal, where Access decides who may connect and Gateway logs the traffic. Its portal is the
connector's deploy inputs (`MCP_PORTAL_URL`, `MCP_PORTAL_NAME`, `MCP_PORTAL_AUTH`,
`MCP_PORTAL_TRUST_ANNOTATIONS`, `MCP_PORTAL_HIDDEN_SERVER_IDS`, and the `MCP_PORTAL_TOKEN` secret; see
`packages/gatekeeper-mcp-portal/README.md`). Only the URL is required; the rest may be left out.
This needs `launch-educate-os` 0.3.0 or later and a release built after SCHO-409 (r000004 or later).

```sh
npx launch-educate-os mcp add --connector portal \
  --portal-url https://portal.northfield.example/mcp --portal-name "District tools" --portal-auth oauth
```

It adds `gatekeeper-mcp-portal` to `gatekeepers`, the URL, name and sign-in to
`gatekeeperInputs["gatekeeper-mcp-portal"]`, and a `{"vendorId": "mcpportal", "access": "all"}`
grant to `DISTRICT_CONFIG.workshopPolicy.connectors`. On a terminal it asks for anything not given.
The answers file never holds a secret, so for `--portal-auth token` the apply reads the token from
`EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN`; once set, later applies keep it without
being given it again, and `mcp status` fails a token portal whose Worker has none. The trust and
hidden-server settings are set by hand in `gatekeeperInputs`. Each grant names one upstream server:
the connector offers no grant over the whole portal.

## 2. Connect AI clients to your district

```sh
npx launch-educate-os mcp clients                    # every client
npx launch-educate-os mcp clients --client chatgpt   # one: claude, chatgpt, claude-code, vscode, cursor, generic
```

It prints the endpoint's URL (`https://<your hostname>/mcp`), checks it live, and then shows each
client's steps with the URL filled in.

**Not usable yet.** The endpoint is built and tested end to end with the official MCP client against
a simulated authorization server, but:

- the district's authorization server, Nathan, doesn't issue tokens for it yet (NATH-6);
- issuing a delegation has an API (`POST /api/teacher/delegations`) and no page yet (SCHO-176);
- no outside client has connected to a district.

`mcp clients` reports each of these as it finds it. The rest of this section is how it works once
they are done.

### Turning it on

Add an `mcp` block to the district service's `DISTRICT_CONFIG` in the answers file (documented in
`packages/educateos-district-worker/README.md`), then apply:

```json
"mcp": {
  "origin": "https://educateos.northfield.example",
  "issuer": "https://id.northfield.example",
  "jwksUri": "https://id.northfield.example/jwks",
  "algorithms": ["ES256"]
}
```

`issuer` must be in the directory's `trustedIssuers` (or `additionalTrustedIssuers`), with each
person's subject there linked to them; `mcp status` fails an issuer the district doesn't trust.
`allowedOrigins` lists the browser origins allowed to call it; clients that send no `Origin` header
(desktop apps, editors, and services such as claude.ai and ChatGPT that call from their servers) need
none.

On a one-origin install, applying answers whose `DISTRICT_CONFIG` has `mcp` also exempts `/mcp`,
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` from
Cloudflare Access (on every hostname the install serves), since MCP clients bring their own token and
can't complete an Access sign-in. Without `mcp`, those paths stay behind Access, and taking `mcp` out
removes the exemption on the next apply.

### How sign-in works

MCP clients don't sign in through Cloudflare Access. The endpoint is an OAuth protected resource: it
publishes RFC 9728 metadata naming the district's authorization server, and answers an
unauthenticated request with 401 pointing at it. The client signs the person in there (authorization
code with PKCE), asking for `resource=https://<your hostname>/mcp` and the scope `mcp:tools`, and
sends the short-lived token. The endpoint checks the signature, issuer, audience, lifetime and scope,
then finds the person through the district's identity links: the token names no role.

`mcp clients` checks the authorization server's metadata: an exact issuer, authorization and token
endpoints, PKCE S256, and whether clients can register themselves (dynamic client registration or
client ID metadata documents). Without either, each client needs a client ID issued for it.

### Who may use it

Staff only: district, school and curriculum administrators, teachers and co-teachers. Students can't
delegate, so no student can use it. Each person issues a **delegation** to the client: the client
(the authorization server's issuer and the client ID it assigned), a ceiling (scope, actions, kinds
of records, classifications) and a duration of at most 90 days. Every call is held to that
delegation and to the person's standing in the roster now. Revoking it, deactivating the person or
unlinking their sign-in stops the next call. Writes wait in the district's approval queue, and MCP
can't approve anything.

### Per client

These are each client's own steps for a remote MCP server with OAuth; `mcp clients` prints them with
your URL. None has been run against an EducateOS district.

- **Claude** (claude.ai, Claude Desktop): Settings → Connectors → Add custom connector, with the URL.
  On Team and Enterprise an Owner adds it under Organization settings → Connectors.
- **ChatGPT**: Settings → Apps & Connectors → Advanced settings → Developer mode, then create a
  connector with the URL and OAuth.
- **Claude Code**: `claude mcp add --transport http educateos <url>`, then `/mcp` to sign in.
- **VS Code**: `.vscode/mcp.json` with `{"servers": {"educateos": {"type": "http", "url": "<url>"}}}`.
- **Cursor**: `~/.cursor/mcp.json` with `{"mcpServers": {"educateos": {"url": "<url>"}}}`.
- **Anything else**: Streamable HTTP, `POST` only (no SSE; GET and DELETE are 405), MCP 2026-07-28 or
  2025-11-25, JSON responses, a bearer token as above.
