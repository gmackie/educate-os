import { useState } from "react";
import { Banner, Button, Checkbox, ClipboardText, Input, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@schoolos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage } from "../app/useLoad.ts";
import { READABLE_KIND_LABEL, READABLE_KINDS } from "./guardianLabels.ts";

type Issued = RouteResponse<"admin.inviteGuardian">;

const expiry = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * Invites a guardian for one student and shows the single-use link to hand them. The link is
 * shown once: the district keeps only a digest of it. Email delivery is not available yet, so the
 * administrator gives the link to the guardian themselves.
 */
export const InviteGuardianForm = ({ studentId, studentName, onInvited }: { studentId: string; studentName: string; onInvited: () => void }) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [name, setName] = useState("");
  const [kinds, setKinds] = useState<ReadonlySet<(typeof READABLE_KINDS)[number]>>(() => new Set(READABLE_KINDS));
  const [issued, setIssued] = useState<Issued>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const toggle = (kind: (typeof READABLE_KINDS)[number], on: boolean) =>
    setKinds((current) => {
      const next = new Set(current);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });

  const invite = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.call("admin.inviteGuardian", {
        params: { studentId },
        body: { guardianDisplayName: name.trim(), readableKinds: READABLE_KINDS.filter((kind) => kinds.has(kind)) },
      });
      setIssued(result);
      setName("");
      announce(`Invitation link for ${result.invitation.guardianDisplayName} ready to copy.`);
      onInvited();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="invite-guardian" className="flex max-w-xl flex-col gap-3">
      <Text as="h4" variant="heading" id="invite-guardian">Invite a guardian</Text>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void invite(); }}>
        <Input
          label="Guardian's name"
          description={`The name their account is created with. Nothing is sent to them: you give them the link.`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{`What they can see of ${studentName}'s classes`}</legend>
          {READABLE_KINDS.map((kind) => (
            <Checkbox key={kind} label={READABLE_KIND_LABEL[kind]} checked={kinds.has(kind)} onCheckedChange={(checked) => toggle(kind, checked === true)} />
          ))}
        </fieldset>
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={name.trim() === "" || kinds.size === 0}>Create invitation link</Button>
        </div>
      </form>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Could not create the invitation" description={error} />}
      {issued !== undefined && (
        <div className="flex flex-col gap-2 rounded-md border border-kumo-line p-3">
          <Text variant="heading" as="p">{`Invitation link for ${issued.invitation.guardianDisplayName}`}</Text>
          <ClipboardText text={issued.invitationUrl} />
          <Text variant="secondary" size="sm">
            {`Give this link to ${issued.invitation.guardianDisplayName} yourself; SchoolOS cannot email it yet. It works once, until ${expiry.format(new Date(issued.invitation.expiresAt))}, and will not be shown again.`}
          </Text>
        </div>
      )}
    </section>
  );
};
