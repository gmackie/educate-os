import { useState } from "react";
import { Badge, Banner, Button, Checkbox, Input, InputArea, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteInput, RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type OpsKey = RouteResponse<"admin.opsKeys">["keys"][number];
type Registration = RouteInput<"admin.enrollOpsKey">["body"]["registration"];
type Scope = Registration["scopes"][number];

/** What each scope lets an admin do here, in the order the form lists them. */
const SCOPES: readonly { scope: Scope; label: string; description: string }[] = [
  { scope: "health", label: "Health and version", description: "Whether the district is up, and which release it runs." },
  { scope: "releases", label: "Releases", description: "The release the district runs." },
  { scope: "analytics", label: "Usage statistics", description: "Requests, errors, storage, AI spend and sign-in counts. Totals only." },
  { scope: "directory:read", label: "Read the directory", description: "People's names, email addresses, roles and schools." },
  { scope: "directory:write", label: "Change accounts", description: "Suspend and restore people, sign them out everywhere, and grant or revoke district administration." },
  { scope: "devices", label: "Phones", description: "List people's phones, and sign them out." },
];

const scopeLabel = (scope: string) => SCOPES.find((s) => s.scope === scope)?.label ?? scope;

const KNOWN_SCOPES = new Set<string>(SCOPES.map((s) => s.scope));

/**
 * Reads the registration an EducateOS admin shows when an operator enrolls this district: its origin,
 * key ID, public key and the scopes it asks for. The district checks it again, strictly.
 */
const readRegistration = (text: string): Registration | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "Paste the registration exactly as the admin shows it. It is JSON, starting with {.";
  }
  const r = value as Partial<Record<keyof Registration, unknown>> | null;
  if (r === null || typeof r !== "object" || typeof r.adminOrigin !== "string" || typeof r.keyId !== "string" || typeof r.publicKey !== "string" || !Array.isArray(r.scopes)) {
    return "This is not an admin registration: it needs adminOrigin, keyId, publicKey and scopes.";
  }
  if (!r.scopes.every((s): s is Scope => typeof s === "string" && KNOWN_SCOPES.has(s))) return "The registration asks for a scope this district doesn't know.";
  return value as Registration;
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The enroll form: paste a registration, tick the scopes to grant, name the admin. */
const EnrollForm = ({ onEnrolled }: { onEnrolled: () => void }) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [granted, setGranted] = useState<Set<Scope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const parsed = text.trim() === "" ? undefined : readRegistration(text);
  const registration = typeof parsed === "object" ? parsed : undefined;

  const toggle = (scope: Scope, on: boolean) => {
    const next = new Set(granted);
    if (on) next.add(scope);
    else next.delete(scope);
    setGranted(next);
  };

  const enroll = async () => {
    if (registration === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const scopes = SCOPES.map((s) => s.scope).filter((s) => granted.has(s));
      const key = await client.call("admin.enrollOpsKey", { body: { registration, scopes, ...(label.trim() === "" ? {} : { label: label.trim() }) } });
      announce(`${key.label} can now operate this district, with ${scopes.length === 1 ? "one scope" : `${scopes.length} scopes`}.`);
      setText("");
      setLabel("");
      setGranted(new Set());
      onEnrolled();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="enroll-admin" className="flex flex-col gap-3 rounded-lg border border-kumo-line p-4">
      <Text as="h3" variant="heading" id="enroll-admin">Enroll an admin</Text>
      <Text variant="secondary">
        When an EducateOS admin (admin.educateos.io, or your own) enrolls this district, it shows a registration. Paste it here, then choose what it may do.
      </Text>
      <InputArea
        label="Registration"
        rows={6}
        className="font-mono"
        value={text}
        onChange={(event) => setText(event.target.value)}
        {...(typeof parsed === "string" ? { error: parsed } : {})}
      />
      {registration !== undefined && (
        <>
          <Text>
            {`From ${registration.adminOrigin}, key ${registration.keyId.slice(0, 20)}…`}
          </Text>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-semibold">Scopes to grant</legend>
            <Text variant="secondary" size="sm">Only what the admin asked for is listed. You can remove the admin, and with it every scope, at any time.</Text>
            {SCOPES.filter((s) => registration.scopes.includes(s.scope)).map((s) => (
              <div key={s.scope} className="flex flex-col">
                <Checkbox label={s.label} checked={granted.has(s.scope)} onCheckedChange={(checked) => toggle(s.scope, checked === true)} />
                <span className="ml-6"><Text variant="secondary" size="sm">{s.description}</Text></span>
              </div>
            ))}
          </fieldset>
          <Input label="Name (optional)" description="How this admin is listed here." value={label} onChange={(event) => setLabel(event.target.value)} />
        </>
      )}
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="The admin was not enrolled" description={error} />}
      <div>
        <Button variant="primary" disabled={registration === undefined || granted.size === 0 || busy} loading={busy} onClick={() => void enroll()}>
          Enroll admin
        </Button>
      </div>
    </section>
  );
};

/**
 * Operations (SCHO-263): which EducateOS admins may operate this district through its signed
 * operations API, with which scopes, and what they did. Each request an admin sends is checked
 * against the key and scopes enrolled here and recorded in this district's own log.
 */
export const OperationsPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const keys = useLoad("ops-keys", (c) => c.call("admin.opsKeys"));
  const audit = useLoad("ops-audit", (c) => c.call("admin.opsAudit"));
  const [removing, setRemoving] = useState<OpsKey>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const remove = async (key: OpsKey) => {
    setBusy(key.keyId);
    setError(undefined);
    try {
      await client.call("admin.removeOpsKey", { params: { keyId: key.keyId } });
      announce(`${key.label} was removed. Its requests are refused from now on.`);
      keys.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Operations</Text>
        <Text variant="secondary">
          An EducateOS admin can check this district's health and usage, and help with accounts and phones, only with the access you grant it here.
          It never holds your Cloudflare credentials, and removing it leaves the district working as before.
        </Text>
      </div>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="That change was not made" description={error} />}
      <section aria-labelledby="admin-access" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="admin-access">Admin access</Text>
        <LoadState loaded={keys} what="the enrolled admins" onRetry={keys.reload}>
          {({ keys: list }) => list.length === 0
            ? <Text variant="secondary">No admin is enrolled. Nobody can use this district's operations API.</Text>
            : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">Enrolled admins</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Admin</Table.Head>
                      <Table.Head>Scopes</Table.Head>
                      <Table.Head>Enrolled</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head><span className="sr-only">Actions</span></Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {list.map((key) => (
                      <Table.Row key={key.keyId}>
                        <Table.Cell>
                          <div className="flex flex-col">
                            <Text>{key.label}</Text>
                            <Text variant="secondary" size="sm">{key.adminOrigin}</Text>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">
                            {key.scopes.map((scope) => <Badge key={scope} variant="neutral">{scopeLabel(scope)}</Badge>)}
                          </div>
                        </Table.Cell>
                        <Table.Cell>{`${when(key.enrolledAt)} by ${key.enrolledBy.displayName}`}</Table.Cell>
                        <Table.Cell>
                          <Badge variant={key.status === "enrolled" ? "success" : "neutral"}>{key.status === "enrolled" ? "Enrolled" : "Removed"}</Badge>
                        </Table.Cell>
                        <Table.Cell>
                          {key.status === "enrolled" && (
                            <Button size="sm" variant="secondary" disabled={busy !== undefined} loading={busy === key.keyId}
                              aria-label={`Remove ${key.label}`} onClick={() => setRemoving(key)}>
                              Remove
                            </Button>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            )}
        </LoadState>
        <EnrollForm onEnrolled={() => { keys.reload(); audit.reload(); }} />
      </section>
      <section aria-labelledby="ops-log" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="ops-log">Recent operations</Text>
        <LoadState loaded={audit} what="the operations log" onRetry={audit.reload}>
          {({ entries }) => entries.length === 0
            ? <Text variant="secondary">No admin has made a request yet.</Text>
            : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">Recent operations requests</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>When</Table.Head>
                      <Table.Head>Admin</Table.Head>
                      <Table.Head>Operator</Table.Head>
                      <Table.Head>Request</Table.Head>
                      <Table.Head>Result</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {entries.map((entry) => (
                      <Table.Row key={entry.id}>
                        <Table.Cell>{when(entry.at)}</Table.Cell>
                        <Table.Cell>{entry.label ?? entry.keyId.slice(0, 20)}</Table.Cell>
                        <Table.Cell>{entry.operator}</Table.Cell>
                        <Table.Cell>{entry.target === undefined ? entry.route : `${entry.route} · ${entry.target}`}</Table.Cell>
                        <Table.Cell>
                          <Badge variant={entry.result.startsWith("refused") || entry.result.startsWith("error") ? "warning" : "neutral"}>{entry.result}</Badge>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            )}
        </LoadState>
      </section>
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removing?.label ?? "this admin"}?`}
        confirmLabel="Remove admin"
        onConfirm={() => {
          const key = removing!;
          setRemoving(undefined);
          void remove(key);
        }}
        onCancel={() => setRemoving(undefined)}
      >
        <p>Its requests are refused from now on. The district keeps working as before.</p>
        <p>To let it back in, enroll its registration again.</p>
      </ConfirmDialog>
    </div>
  );
};
