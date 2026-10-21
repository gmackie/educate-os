import { Badge, Banner, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@schoolos/api-client";
import { count } from "../app/labels.ts";

/** What a roster import would change, as the district previews it. */
export type RosterPreviewBody = RouteResponse<"admin.previewRoster">;
type QuarantinedUser = RosterPreviewBody["quarantined"][number];

const RECORD_TYPES = [
  ["schools", "Schools"],
  ["terms", "Terms"],
  ["courses", "Courses"],
  ["offerings", "Classes"],
  ["principals", "People"],
  ["enrollments", "Enrollments"],
] as const;

/**
 * Why a user was held back, and what the administrator can do about it. Resolving a quarantine
 * from the console (confirming a sign-in change or merging a re-keyed user) is not available yet,
 * so each reason points to the fix in the student information system.
 */
const QUARANTINE_GUIDANCE: Record<QuarantinedUser["reason"], { reason: string; nextStep: string }> = {
  "missing-subject": {
    reason: "No sign-in identity in the export",
    nextStep: "Fill in this user's sign-in field in your student information system, then import again.",
  },
  "duplicate-subject": {
    reason: "Shares a sign-in identity with another user in the export",
    nextStep: "Correct the sign-in of one of the two users in your student information system, then import again.",
  },
  "subject-changed": {
    reason: "Sign-in identity differs from the one this person already uses",
    nextStep: "If the change is intended, confirming it from the console is coming soon; until then, restore the previous sign-in in your student information system or contact SchoolOS support.",
  },
  "subject-in-use": {
    reason: "Sign-in identity already belongs to a different person",
    nextStep: "Check whether this is the same person under a new record. Merging records from the console is coming soon; until then, correct the record in your student information system.",
  },
  "kind-changed": {
    reason: "Would change between student and staff",
    nextStep: "Check this user's role in your student information system. A person cannot move between student and staff by import.",
  },
  "conflicting-roles": {
    reason: "Has both student and staff roles",
    nextStep: "Give this user either student or staff roles in your student information system, then import again.",
  },
  "no-role": {
    reason: "Has no role",
    nextStep: "Give this user a role in roles.csv, then import again.",
  },
};

/** The quarantine list: users the import leaves out, why, and the next step for each. */
export const QuarantineList = ({ quarantined }: { quarantined: readonly QuarantinedUser[] }) => (
  <section aria-labelledby="quarantine-heading" className="flex flex-col gap-2">
    <Text as="h4" variant="heading" id="quarantine-heading">Held for review ({quarantined.length})</Text>
    {quarantined.length === 0 ? <Text variant="secondary">No users are held for review.</Text> : (
      <>
        <Text variant="secondary">
          These users are left out of the import. Anyone among them who already uses SchoolOS keeps their access and classes exactly as they are until this is resolved.
        </Text>
        <ul className="flex flex-col gap-2">
          {quarantined.map((user) => {
            const guidance = QUARANTINE_GUIDANCE[user.reason];
            return (
              <li key={`${user.sourcedId}:${user.row}`} className="flex flex-col gap-1 rounded-md border border-kumo-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">{guidance.reason}</Badge>
                  <Text as="span" variant="mono">users.csv row {user.row}</Text>
                  <Text as="span" variant="secondary">record {user.sourcedId}</Text>
                </div>
                <Text>{user.message}</Text>
                {user.heldEnrollments > 0 && <Text variant="secondary">{count(user.heldEnrollments, "class enrollment")} held unchanged.</Text>}
                <Text><Text as="strong" bold>Next step:</Text> {guidance.nextStep}</Text>
              </li>
            );
          })}
        </ul>
      </>
    )}
  </section>
);

/** The roster preview: changes per record type, problems that block applying, and the quarantine list. */
export const RosterPreview = ({ preview }: { preview: RosterPreviewBody }) => {
  const errors = preview.issues.filter((i) => i.severity === "error");
  const warnings = preview.issues.filter((i) => i.severity === "warning");
  const { roleAssignments } = preview.changes;
  return (
    <div className="flex flex-col gap-6">
      {!preview.canApply && (
        <Banner
          variant="error"
          icon={<Warning weight="fill" />}
          title="This export cannot be applied"
          description="Fix the problems listed below in the export, then preview it again. Nothing has changed."
        />
      )}
      <section aria-labelledby="roster-changes-heading" className="flex flex-col gap-2">
        <Text as="h4" variant="heading" id="roster-changes-heading">Changes</Text>
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Records added, updated and deactivated by type</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Records</Table.Head>
                <Table.Head>Added</Table.Head>
                <Table.Head>Updated</Table.Head>
                <Table.Head>Deactivated</Table.Head>
                <Table.Head>Kept unchanged</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {RECORD_TYPES.map(([key, label]) => {
                const changes = preview.changes[key];
                return (
                  <Table.Row key={key}>
                    <Table.Cell>{label}</Table.Cell>
                    <Table.Cell>{changes.added.length}</Table.Cell>
                    <Table.Cell>{changes.updated.length}</Table.Cell>
                    <Table.Cell>{changes.deactivated.length}</Table.Cell>
                    <Table.Cell>{changes.retained.length}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
        <Text variant="secondary">
          Roles: {count(roleAssignments.added.length, "role")} granted, {count(roleAssignments.removed.length, "role")} removed. {count(preview.linked.length, "user")} linked to people who already sign in.
        </Text>
      </section>

      {(errors.length > 0 || preview.integrity.length > 0) && (
        <section aria-labelledby="roster-errors-heading" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="roster-errors-heading">Problems that block applying</Text>
          <ul className="list-disc pl-5">
            {errors.map((issue, index) => (
              <li key={`e${index}`}>{[issue.file, issue.row === undefined ? undefined : `row ${issue.row}`].filter(Boolean).join(" ")}{issue.file !== undefined ? ": " : ""}{issue.message}</li>
            ))}
            {preview.integrity.map((issue) => <li key={`i:${issue.path}`}>{issue.message}</li>)}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section aria-labelledby="roster-warnings-heading" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="roster-warnings-heading">Skipped on purpose</Text>
          <ul className="list-disc pl-5">
            {warnings.map((issue, index) => <li key={`w${index}`}>{issue.file === undefined ? "" : `${issue.file}: `}{issue.message}</li>)}
          </ul>
        </section>
      )}

      <QuarantineList quarantined={preview.quarantined} />
    </div>
  );
};
