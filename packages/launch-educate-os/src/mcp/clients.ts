// How each AI client connects to a remote MCP server, applied to the district's `/mcp`.
//
// These are the clients' own documented steps for a remote (Streamable HTTP) server that signs in
// with OAuth. None has been run against an EducateOS district yet: no authorization server issues
// tokens for a district's `/mcp` (NATH-6), so every guide says so.

/** One AI client's setup. */
export interface ClientGuide {
  /** The `--client` value. */
  id: string;
  name: string;
  /** Steps, in order. `{url}` is the district's MCP URL. */
  steps: string[];
  /** A config file to paste, if the client takes one. */
  snippet?: { file: string; text: string };
}

/** The clients `mcp clients` explains, in the order it prints them. */
export const CLIENT_GUIDES: readonly ClientGuide[] = [
  {
    id: "claude",
    name: "Claude (claude.ai and Claude Desktop)",
    steps: [
      "Settings → Connectors → Add custom connector. On a Team or Enterprise plan an Owner adds it under Organization settings → Connectors, and members then connect it.",
      "Name: your district's name. Remote MCP server URL: {url}",
      "Leave Advanced settings empty if your authorization server allows dynamic client registration; otherwise enter the OAuth client ID it issued for Claude.",
      "Connect. Claude opens your authorization server's sign-in; sign in as yourself.",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    steps: [
      "Settings → Apps & Connectors → Advanced settings: turn on Developer mode (a workspace admin may have to allow it on Business, Enterprise and Edu).",
      "Create a connector. MCP server URL: {url}. Authentication: OAuth.",
      "Sign in at your authorization server when ChatGPT asks.",
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    steps: [
      "Run: claude mcp add --transport http educateos {url}",
      "In Claude Code, run /mcp and choose educateos to sign in.",
    ],
  },
  {
    id: "vscode",
    name: "VS Code (GitHub Copilot agent mode)",
    steps: [
      "Add the server to .vscode/mcp.json (or run \"MCP: Add Server\" and choose HTTP).",
      "Start it from the file's code lens; VS Code opens the sign-in.",
    ],
    snippet: { file: ".vscode/mcp.json", text: `{\n  "servers": {\n    "educateos": { "type": "http", "url": "{url}" }\n  }\n}` },
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      "Add the server to ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (one project).",
      "Settings → MCP: the server shows \"Needs login\"; select it to sign in.",
    ],
    snippet: { file: "~/.cursor/mcp.json", text: `{\n  "mcpServers": {\n    "educateos": { "url": "{url}" }\n  }\n}` },
  },
  {
    id: "generic",
    name: "Any other MCP client",
    steps: [
      "Transport: Streamable HTTP, POST {url} only (GET and DELETE answer 405; responses are JSON, never a stream).",
      "Protocol: MCP 2026-07-28 (stateless, server/discover) or 2025-11-25 (initialize). No session ID.",
      "Sign-in: OAuth 2.1 authorization code with PKCE at the authorization server the endpoint's metadata names, asking for resource={url} and scope mcp:tools. Send the access token as Authorization: Bearer.",
      "A client that calls from a web page must have its origin in DISTRICT_CONFIG.mcp.allowedOrigins; clients that send no Origin header need nothing.",
    ],
  },
];

/** `text` with the district's MCP URL in place of `{url}`. */
export function withUrl(text: string, url: string): string {
  return text.replaceAll("{url}", url);
}
