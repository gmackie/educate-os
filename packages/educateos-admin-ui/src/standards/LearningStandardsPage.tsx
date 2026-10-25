import { useState } from "react";
import { Badge, Banner, Button, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type Standards = RouteResponse<"admin.listStandards">[number];

const SUBJECT_LABEL: Record<string, string> = {
  "mathematics": "Mathematics",
  "english-language-arts": "English language arts",
  "science": "Science",
  "social-studies": "Social studies",
  "social-emotional-learning": "Social-emotional learning",
};

const subjects = (standards: Standards) => standards.subjects.map((s) => SUBJECT_LABEL[s] ?? s).join(", ");
const grades = (standards: Standards) => standards.gradeBands.map((band) => (band === "PK" ? "Pre-K" : band)).join(", ");

/**
 * Learning standards (SCHO-220): the standards that ship with EducateOS, and which of them the
 * district approves. Teachers choose an activity's learning goals from the approved standards that
 * cover their course's subject and grades, so approving one is what makes its goals available.
 */
export const LearningStandardsPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const standards = useLoad("standards", (c) => c.call("admin.listStandards"));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [withdrawing, setWithdrawing] = useState<Standards>();

  const decide = async (entry: Standards, approve: boolean) => {
    setBusy(entry.frameworkKey);
    setError(undefined);
    try {
      const params = { frameworkKey: entry.frameworkKey };
      await (approve ? client.call("admin.approveStandards", { params }) : client.call("admin.withdrawStandards", { params }));
      announce(approve ? `${entry.title} approved. Teachers can now choose its learning goals.` : `${entry.title} withdrawn.`);
      standards.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Learning standards</Text>
        <Text variant="secondary">
          Approve the standards your district teaches to. When teachers create an activity, they can choose learning goals from the approved
          standards that cover their course's subject and grades. Learning goals are optional, so activities can be created before any are approved.
        </Text>
        <Text variant="secondary">
          These standards ship with EducateOS because their publishers allow their text to be shared. Others, such as the Next Generation Science
          Standards, are not built in and cannot be approved here yet.
        </Text>
      </div>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="That change was not made" description={error} />}
      <LoadState loaded={standards} what="the learning standards" onRetry={standards.reload}>
        {(list) => (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">Learning standards built into EducateOS</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Standards</Table.Head>
                  <Table.Head>Subjects</Table.Head>
                  <Table.Head>Grades</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {list.map((entry) => (
                  <Table.Row key={entry.frameworkKey}>
                    <Table.Cell>
                      <div className="flex flex-col">
                        <Text>{entry.title}</Text>
                        <Text variant="secondary" size="sm">{`${entry.publisher} · ${entry.license.name}`}</Text>
                      </div>
                    </Table.Cell>
                    <Table.Cell>{subjects(entry)}</Table.Cell>
                    <Table.Cell>{grades(entry)}</Table.Cell>
                    <Table.Cell>
                      <Badge variant={entry.status === "approved" ? "success" : "neutral"}>{entry.status === "approved" ? "Approved" : "Not approved"}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      {entry.status === "approved"
                        ? (
                          <Button size="sm" variant="secondary" disabled={busy !== undefined} loading={busy === entry.frameworkKey}
                            aria-label={`Withdraw ${entry.title}`} onClick={() => setWithdrawing(entry)}>
                            Withdraw
                          </Button>
                        )
                        : (
                          <Button size="sm" variant="primary" disabled={busy !== undefined} loading={busy === entry.frameworkKey}
                            aria-label={`Approve ${entry.title}`} onClick={() => void decide(entry, true)}>
                            Approve
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
      <ConfirmDialog
        open={withdrawing !== undefined}
        title={`Withdraw ${withdrawing?.title ?? "these standards"}?`}
        confirmLabel="Withdraw standards"
        onConfirm={() => {
          const entry = withdrawing!;
          setWithdrawing(undefined);
          void decide(entry, false);
        }}
        onCancel={() => setWithdrawing(undefined)}
      >
        <p>Teachers stop seeing its learning goals when they create or revise an activity, and the district refuses them.</p>
        <p>Activities already aligned to it keep their goals. You can approve it again at any time.</p>
      </ConfirmDialog>
    </div>
  );
};
