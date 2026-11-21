# Setting up MCP

- Audience: district/school owners and IT, using `npx launch-educate-os`.
- Status: built and tested across `@educateos/external-mcp`, `@educateos/district-worker`, `@educateos/admin-ui`, `@educateos/teacher-ui`, `@educateos/installer`, and `launch-educate-os` (including full LMS-lite tools, built-in Cloudflare OAuth 2.1, scoped personal bearer tokens, and Management UI approval queues). Validated in production on Northfield and Harbor on 2026-11-21 with a scripted OAuth client ([evidence](mcp-validation/README.md)); no Claude or ChatGPT app has connected to a district yet.
- Commands: `npx launch-educate-os mcp status | enable | disable | clients | add` ([launch-installer.md](launch-installer.md#mcp-setup-scho-407)
  has how they work).

MCP (the Model Context Protocol) is how AI tools reach outside services. EducateOS uses it two ways,
and they are set up separately:

| | Your district's MCP endpoint | The Workshop's MCP connectors |
| --- | --- | --- |
| Direction | Outside AI clients call **your district's LMS-lite** | **Workshop agents** call outside MCP servers |
| Who uses it | Staff, from Claude, ChatGPT, Claude Code, VS Code, Cursor, or CLI tools | District administrators connect servers; agents and Gadgets are granted them |
| Where it lives | The district Worker's `/mcp` (55+ LMS-lite tools), turned on by `DISTRICT_CONFIG.mcp` | `gatekeeper-mcp` (MCP Server) and `gatekeeper-mcp-portal` (MCP Server Portal) |
| Sign-in | **Built-in Cloudflare OAuth 2.1** backed by your school's Cloudflare Access login (zero external IdP) + optional scoped personal bearer tokens in the Management UI; or an external OAuth issuer | Each server's own sign-in (OAuth), or none |
| Management UI | Built-in at `https://<your hostname>/admin/#/mcp` (district admins) and `/teach/#/mcp` (teachers) | Workshop `/ai/admin?tab=gatekeepers` |

Start with `npx launch-educate-os mcp status` in the directory holding `educateos-install.json`. It
reports both sides and checks the endpoint live. Set `CLOUDFLARE_API_TOKEN` to also check the
connectors' Workers in your account.

## Minimal setup: School LMS Lite + MCP Server on Cloudflare

A school or district owner can deploy the entire LMS-lite + full MCP server + Management UI into their
own Cloudflare account with one command and **no external identity server**:

```sh
npx launch-educate-os
```

1. In the wizard, install the district LMS and let the wizard write your starting configuration from a
   few questions. Built-in Cloudflare OAuth 2.1 MCP (`mode: "builtin"`, `allowDrafts: true`) is enabled
   automatically.
2. When asked whether to turn on the AI Workshop / AI Gateway:
   - Choose **No** for **LMS-lite + MCP-only mode** (just the district LMS, full `/mcp` server, and
     Management UI — no AI Gateway or AI Workshop needed).
   - Choose **Yes** to also run the AI Workshop at `/ai`.
3. Once installed, open `https://<your hostname>/admin/#/mcp` (or `/teach/#/mcp` for teachers) to copy
   ready-to-paste client configs, mint scoped personal tokens for CLI tools, revoke delegations, and
   approve or decline queued MCP writes.

For an existing install that does not yet have `DISTRICT_CONFIG.mcp`:

```sh
npx launch-educate-os mcp enable
npx launch-educate-os --config educateos-install.json
```

Pass `--strict-writes` to `mcp enable` if you want draft tools (new draft modules, activities and
quizzes, teacher-only feedback and scores) to also wait in the approval queue instead of running immediately.

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

### Turning it on

New installs written by `npx launch-educate-os` enable built-in Cloudflare OAuth 2.1 MCP by default.
To turn it on (or switch to strict write confirmation) on an existing install, run
`npx launch-educate-os mcp enable` and apply, which writes:

```json
"mcp": {
  "mode": "builtin",
  "origin": "https://educateos.northfield.example",
  "allowDrafts": true
}
```

If you prefer to use a separate external OAuth authorization server instead of the built-in server,
supply `issuer`, `jwksUri` and `algorithms` in `DISTRICT_CONFIG.mcp`:

```json
"mcp": {
  "origin": "https://educateos.northfield.example",
  "issuer": "https://id.northfield.example",
  "jwksUri": "https://id.northfield.example/jwks",
  "algorithms": ["ES256"]
}
```

`allowedOrigins` lists exact browser origins allowed to call `/mcp`; clients that send no `Origin`
header (desktop apps, editors, and services such as claude.ai and ChatGPT that call from their
servers) need none.

On a one-origin install, applying answers whose `DISTRICT_CONFIG` has `mcp` exempts `/mcp`,
`/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`, `/oauth/register`,
`/oauth/token` and `/oauth/revoke` from Cloudflare Access, while keeping `/oauth/authorize` strictly
**behind Cloudflare Access** so staff sign in with their school SSO before approving any connection.

### How sign-in works

- **Built-in Cloudflare OAuth 2.1 (default):** The district Worker publishes RFC 9728 protected
  resource metadata pointing to itself as the OAuth 2.1 authorization server (RFC 8414, RFC 7591
  Dynamic Client Registration, Client ID Metadata Documents, PKCE S256, RFC 8707 resource binding,
  RFC 9207 `iss`). When an AI client opens `/oauth/authorize`, Cloudflare Access authenticates the
  staff member with the school's IdP, the district shows a consent screen to pick scope (whole
  district, school, or individual class), access level, and expiry (up to 90 days), creates a live
  IF-06 delegation, and issues short-lived ES256 access tokens (10 min) plus rotating refresh tokens.
- **Scoped personal bearer tokens:** Staff and admins can also mint scoped `edum_*` bearer tokens in
  the Management UI (`/admin/#/mcp` or `/teach/#/mcp`) for headless CLI tools and scripts. Each token
  is bound to a real delegation, stored only as a SHA-256 digest, and revocable in one click.

### Who may use it and write safety

Staff only: district, school and curriculum administrators, teachers and co-teachers. Students can't
delegate, so no student can use it. Every call is evaluated against the person's live directory
standing and active delegation ceiling:

- **Reads** (directory, rosters, modules, pages, activities, assignments, submissions, feedback,
  gradebook, quizzes, discussions, announcements, resources, workspaces, planner, guidance) run
  immediately.
- **Low-risk drafts** (new draft modules, activities and quizzes; teacher-only feedback comments,
  criterion scores and quiz-item scores) run immediately when `allowDrafts: true`, or wait in the
  approval queue when `allowDrafts: false`. Nothing a student or family can see changes this way.
- **Consequential writes** (creating/updating courses/offerings/enrollments, adding or editing course
  pages, editing quizzes, publishing modules, activities, quizzes or feedback, discussion topics,
  announcements and weekly family notes, moderating posts, proposing grades) always
  wait in the Management UI approval queue (`/admin/#/mcp` or `/teach/#/mcp`). MCP can never approve
  its own requests.
- **Human-only operations** (official grade approval/release, identity links, district-admin grants,
  delegation management, IEP/504 accommodations, audit logs, bulk exports) are never exposed over MCP.

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
