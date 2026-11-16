// Short-lived Canvas credentials for the synthetic demo people, so each acts as themself.
//
// The demo Canvas (canvas.mackie.house) sends logins to its default account, and the synthetic
// people have no passwords, so their credentials are minted in the Canvas Rails console instead:
// an API token that expires within the hour, or a single-use session token for a browser launch.
// Only `educateos-demo:` SIS logins in account 3 can be minted, and `expire()` revokes every token
// a run minted. Credentials stay in memory; nothing is written to disk or logged.
import { execFileSync } from "node:child_process";

/** The command that pipes Ruby into `rails runner -` on the Canvas host. Override with CANVAS_RAILS_RUNNER (JSON array). */
export const DEFAULT_RAILS_RUNNER: readonly string[] = [
  "ssh", "labnuc", "sudo -n podman exec -i canvas-v2-web-1 bash -lc 'cd /usr/src/app && bin/rails runner -'",
];

/** A synthetic person's own short-lived Canvas API credential. */
export interface CanvasCredential { principalId: string; userId: number; token: string }

/** Mints and revokes demo people's credentials. */
export interface CanvasActors {
  /** Own API credentials for these fixture principals; unknown or non-demo principals are omitted. */
  credentials(principalIds: readonly string[]): Promise<Map<string, CanvasCredential>>;
  /** A single-use browser session token for one fixture principal. */
  session(principalId: string): Promise<string>;
  /** Expires every API credential this run minted; returns how many remain active (0). */
  expire(): Promise<number>;
}

const SAFE_ID = /^prn_[a-z0-9-]+$/;

/** Runs Ruby in the Canvas Rails console and parses the line it prints as `DATA=<json>`. */
export type RailsRunner = (ruby: string) => unknown;

export function railsRunner(command: readonly string[] = DEFAULT_RAILS_RUNNER): RailsRunner {
  return (ruby) => {
    const out = execFileSync(command[0]!, command.slice(1), { input: ruby, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    const line = out.split("\n").find((l) => l.startsWith("DATA="));
    if (line === undefined) throw new Error("The Canvas console printed no result");
    return JSON.parse(line.slice("DATA=".length));
  };
}

/** Credentials minted through the Canvas console, tagged with `purpose` so they can all be expired. */
export function consoleActors(run: RailsRunner, purpose: string): CanvasActors {
  if (!/^[A-Za-z0-9 :_-]+$/.test(purpose)) throw new Error("Unsafe credential purpose");
  const ids = (principalIds: readonly string[]) => {
    for (const id of principalIds) if (!SAFE_ID.test(id)) throw new Error(`Refusing principal ID ${JSON.stringify(id)}`);
    return JSON.stringify(principalIds.map((id) => `educateos-demo:${id}`));
  };
  return {
    async credentials(principalIds) {
      if (principalIds.length === 0) return new Map();
      const rows = run(`require "json"
rows=Pseudonym.active.where(account_id:3,sis_user_id:${ids(principalIds)}).preload(:user).map{|p|
 t=p.user.access_tokens.create!(purpose:"${purpose}",permanent_expires_at:Time.now.utc+3600)
 {principalId:p.sis_user_id.delete_prefix("educateos-demo:"),userId:p.user_id,token:t.full_token}}
puts "DATA="+JSON.generate(rows)`) as CanvasCredential[];
      return new Map(rows.map((r) => [r.principalId, r]));
    },
    async session(principalId) {
      return run(`require "json"
p=Pseudonym.active.find_by!(account_id:3,sis_user_id:${ids([principalId])}.first)
puts "DATA="+JSON.generate(SessionToken.new(p.id).to_s)`) as string;
    },
    async expire() {
      return run(`require "json"
AccessToken.where(purpose:"${purpose}").update_all(permanent_expires_at:Time.now.utc-60)
puts "DATA="+JSON.generate(AccessToken.active.where(purpose:"${purpose}").count)`) as number;
    },
  };
}
