import { useState } from "react";
import { Select, Text } from "@cloudflare/kumo";
import { DecisionTable } from "./DecisionTable.tsx";
import { FILTER_KINDS, words } from "./decisionLabels.ts";
import { useDecisionPages } from "./useDecisionPages.ts";

type Kind = (typeof FILTER_KINDS)[number];

/**
 * The admin audit log (SCHO-376): every change an administrator was allowed to make, from the
 * district's decision log, newest first. Read-only.
 */
export const AdminAuditLogPage = () => {
  const [kind, setKind] = useState<Kind | null>(null);
  const pages = useDecisionPages("admin.auditLog", kind === null ? {} : { resourceKind: kind });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Admin audit log</Text>
        <Text variant="secondary">
          Every change an administrator was allowed to make, by anyone acting as one: people and roles, classes and enrollments, roster syncs, guardians and sign-in links, configuration, AI budgets, operations access and district exports.
          Each entry is the decision that allowed the change, recorded before the change was made, so a change that then failed its checks is listed too.
        </Text>
        <Text variant="secondary">
          Configuration versions are listed in full under Modules and activation, and what an EducateOS admin did through the operations API under Operations.
          Sign-ins themselves are not listed: Cloudflare Access and your identity provider record them.
        </Text>
      </div>
      <section aria-labelledby="admin-changes" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="admin-changes">Changes</Text>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select<Kind | null>
            label="Record"
            className="min-w-48"
            value={kind}
            renderValue={(value) => (value === null ? "Every kind" : words(value))}
            onValueChange={(value) => setKind(value)}
          >
            <Select.Option value={null}>Every kind</Select.Option>
            {FILTER_KINDS.map((value) => <Select.Option key={value} value={value}>{words(value)}</Select.Option>)}
          </Select>
        </div>
        <DecisionTable pages={pages} label="Administrators' changes, newest first" what="the admin audit log" empty="No administrator has changed anything yet." />
      </section>
    </div>
  );
};
