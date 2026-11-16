import { useState } from "react";
import { Button, Input, Surface, Text } from "@cloudflare/kumo";
import { useApi } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { NoticeAcceptance, type FamilyNoticeView } from "./FamilyNotice.tsx";
import { LearnerFields, NEW_LEARNER, type LearnerDraft } from "./LearnerFields.tsx";

/**
 * Starting a family: its name, the adult PIN that ends a child's practice on a shared device, the
 * first child, and accepting the notice about how the family's information is kept. The PIN is
 * checked by the server and stored only as a hash.
 */
export const FamilySetup = ({ notice, onCreated }: { notice: FamilyNoticeView; onCreated: () => void }) => {
  const api = useApi();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [child, setChild] = useState<LearnerDraft>(NEW_LEARNER);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const pinValid = /^\d{4,8}$/.test(pin);
  const ready = name.trim() !== "" && pinValid && pin === confirm && child.displayName.trim() !== "" && accepted;
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.call("family.create", { body: { name: name.trim(), pin, acceptNotice: notice.version } });
      await api.call("family.addLearner", { body: { ...child, displayName: child.displayName.trim(), avatar: child.avatar as never } });
      onCreated();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="family-setup" className="flex max-w-2xl flex-col gap-6">
      <PageHeading id="family-setup">Set up home learning</PageHeading>
      <Text>Short reading and number practice for children in kindergarten to second grade. You choose what to practice; your child practices; you see what they did.</Text>
      <Text variant="secondary">Joining a family another grown-up already set up? Open the invitation link they sent you instead.</Text>
      <form className="flex flex-col gap-6" onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}>
        <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
          <h2 className="text-lg font-semibold">Your family</h2>
          <Input label="Family name" description='For example, "The Rivers family".' maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
          <Input label="Family PIN" description="4 to 8 digits. You'll enter it to finish your child's practice on a shared device." type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(event) => setPin(event.target.value)} />
          <Input label="Type the PIN again" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          {pin !== "" && !pinValid ? <p className="text-kumo-danger">Use 4 to 8 digits.</p> : null}
          {pinValid && confirm !== "" && confirm !== pin ? <p className="text-kumo-danger">The PINs don't match.</p> : null}
        </Surface>
        <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
          <h2 className="text-lg font-semibold">Your first child</h2>
          <LearnerFields idPrefix="setup" value={child} onChange={setChild} />
        </Surface>
        <NoticeAcceptance notice={notice} accepted={accepted} onChange={setAccepted} />
        {error === undefined ? null : <ErrorState error={error} title="We couldn't set up your family" />}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!ready} className="self-start">Start home learning</Button>
      </form>
    </section>
  );
};
