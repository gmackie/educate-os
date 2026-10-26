import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Table, Text } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import type { DistrictApiClient, RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { formatMoment } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";
import { READABLE_KIND_LABEL, STANDING, standingOf } from "./guardianLabels.ts";
import { DigestPreview } from "./DigestPreview.tsx";
import { InviteGuardianForm } from "./InviteGuardianForm.tsx";
import { RelationshipActions } from "./RelationshipActions.tsx";

type Overview = RouteResponse<"admin.studentGuardians">;

/** Runs one change to the district, then announces and shows it and reloads, or shows why it failed. */
const useChange = (reload: () => void) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const run = async (message: string, change: (client: DistrictApiClient) => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await change(client);
      announce(message);
      setDone(message);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
};

/** A sign-in's provider, by its host: `https://coop.cloudflareaccess.com` reads "coop.cloudflareaccess.com". */
const providerOf = (issuer: string) => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

/** A guardian's name: their account's once their sign-in is approved, else the name they were invited under. */
const guardianName = (overview: Overview, row: Overview["relationships"][number]): string =>
  row.guardianDisplayName
    ?? overview.invitations.find((i) => i.reservedGuardianPrincipalId === row.relationship.guardianPrincipalId)?.guardianDisplayName
    ?? "Invited guardian";

/** One student's guardians: sign-ins to approve, relationships to confirm or end, and a new invitation. */
export const StudentGuardians = ({ studentId }: { studentId: string }) => {
  const overview = useLoad(`student-guardians:${studentId}`, (client) => client.call("admin.studentGuardians", { params: { studentId } }));
  const change = useChange(overview.reload);
  const heading = useRef<HTMLHeadingElement>(null);

  // Choosing a student moves focus to their guardians, so keyboard and screen-reader users land on them.
  const ready = overview.status === "ready";
  useEffect(() => {
    if (ready) heading.current?.focus();
  }, [ready]);

  return (
    <LoadState loaded={overview} what="this student's guardians" onRetry={overview.reload}>
      {(data) => (
        <section aria-labelledby="student-guardians" className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text as="h3" variant="heading" size="lg">
              <span id="student-guardians" ref={heading} tabIndex={-1} className="outline-none">Guardians of {data.student.displayName}</span>
            </Text>
            {/* A guardian redeems their link on their own time, so the list is refreshed on request. */}
            <Button size="sm" variant="secondary" onClick={overview.reload}>Refresh</Button>
          </div>
          {change.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="That change was not made" description={change.error} />}
          {change.done !== undefined && <Banner icon={<CheckCircle weight="fill" />} title={change.done} />}

          {data.pendingSignIns.length > 0 && (
            <section aria-labelledby="pending-sign-ins" className="flex flex-col gap-2">
              <Text as="h4" variant="heading" id="pending-sign-ins">Sign-ins to approve</Text>
              <Text variant="secondary">
                These people opened their invitation link and signed in. Check the sign-in ID is the person you invited, for example against your sign-in provider's user list: approving links that sign-in to the guardian account. They still see nothing until you confirm them below.
              </Text>
              <ul className="flex flex-col gap-2">
                {data.pendingSignIns.map((signIn) => (
                  <li key={signIn.requestId} className="flex flex-wrap items-center gap-3 rounded-md border border-kumo-line p-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Text bold>{signIn.guardianDisplayName}</Text>
                      <Text variant="secondary" size="sm">Invited under this name. Used the link on {formatMoment(signIn.requestedAt)}, signed in through {providerOf(signIn.signIn.issuer)}.</Text>
                      <Text variant="secondary" size="sm">
                        Sign-in ID: <Text as="span" variant="mono">{signIn.signIn.subject}</Text>
                      </Text>
                    </div>
                    <Button
                      variant="primary"
                      disabled={change.busy}
                      aria-label={`Approve ${signIn.guardianDisplayName}'s sign-in`}
                      onClick={() => void change.run(`${signIn.guardianDisplayName}'s sign-in approved.`, (client) =>
                        client.call("admin.approveIdentityRequest", { params: { requestId: signIn.requestId } }))}
                    >
                      Approve sign-in
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={change.busy}
                      aria-label={`Reject ${signIn.guardianDisplayName}'s sign-in`}
                      onClick={() => void change.run(`${signIn.guardianDisplayName}'s sign-in rejected.`, (client) =>
                        client.call("admin.rejectIdentityRequest", { params: { requestId: signIn.requestId } }))}
                    >
                      Reject
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="relationships" className="flex flex-col gap-2">
            <Text as="h4" variant="heading" id="relationships">Relationships</Text>
            {data.relationships.length === 0 ? (
              <Text variant="secondary">{data.student.displayName} has no guardians on EducateOS yet. Invite one below.</Text>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">{`Guardian relationships of ${data.student.displayName}`}</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Guardian</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Can see</Table.Head>
                      <Table.Head>Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.relationships.map((row) => {
                      const name = guardianName(data, row);
                      const standing = standingOf(row);
                      return (
                        <Table.Row key={row.relationship.id}>
                          <Table.Cell>{name}</Table.Cell>
                          <Table.Cell><Badge variant={STANDING[standing].variant}>{STANDING[standing].label}</Badge></Table.Cell>
                          <Table.Cell>
                            {row.relationship.readableKinds.map((kind) => READABLE_KIND_LABEL[kind]).join(", ")}
                            {row.relationship.offeringIds === undefined ? "" : ` (${row.relationship.offeringIds.length === 1 ? "one class" : `${row.relationship.offeringIds.length} classes`})`}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-2">
                              <RelationshipActions
                                guardianName={name}
                                studentName={data.student.displayName}
                                readable={row.relationship.readableKinds.map((kind) => READABLE_KIND_LABEL[kind])}
                                classCount={row.relationship.offeringIds?.length}
                                standing={standing}
                                busy={change.busy}
                                onConfirm={() => change.run(`${name} confirmed as a guardian.`, (client) =>
                                  client.call("admin.confirmGuardian", { params: { relationshipId: row.relationship.id } }))}
                                onSuspend={(reason) => change.run(`${name}'s access suspended.`, (client) =>
                                  client.call("admin.suspendGuardian", { params: { relationshipId: row.relationship.id }, body: { reason } }))}
                                onResume={() => change.run(`${name}'s access restored.`, (client) =>
                                  client.call("admin.resumeGuardian", { params: { relationshipId: row.relationship.id } }))}
                                onRevoke={() => change.run(`${name}'s relationship ended.`, (client) =>
                                  client.call("admin.revokeGuardian", { params: { relationshipId: row.relationship.id } }))}
                              />
                              {standing === "active" && <DigestPreview guardianPrincipalId={row.relationship.guardianPrincipalId} guardianName={name} />}
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </div>
            )}
          </section>

          <InviteGuardianForm studentId={studentId} studentName={data.student.displayName} onInvited={overview.reload} />
        </section>
      )}
    </LoadState>
  );
};
