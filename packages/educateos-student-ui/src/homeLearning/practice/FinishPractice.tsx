import { useState } from "react";
import { Button, Dialog, Input } from "@cloudflare/kumo";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { DistrictApiError } from "@educateos/api-client";
import { useApi } from "../../api.tsx";

/**
 * The grown-up's way out of practice: the family PIN, checked by the server, ends the child session
 * on this browser. A wrong PIN, or too many, is said plainly.
 */
export const FinishPractice = ({ onEnded }: { onEnded: () => void }) => {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.call("learner.exit", { body: { pin } });
      setOpen(false);
      onEnded();
    } catch (caught) {
      setError(caught instanceof DistrictApiError && caught.code === "forbidden" ? caught.message : "We couldn't check the PIN. Try again.");
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Button variant="ghost" icon={<LockSimpleIcon aria-hidden />} onClick={() => setOpen(true)}>Grown-up: finish practice</Button>
      <Dialog className="flex flex-col gap-4 p-6" size="sm">
        <Dialog.Title className="text-xl font-semibold">Finish practice</Dialog.Title>
        <Dialog.Description className="text-kumo-subtle">Enter your family PIN to go back to the grown-up pages.</Dialog.Description>
        <form className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}>
          <Input label="Family PIN" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} />
          {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props} disabled={busy}>Cancel</Button>} />
            <Button type="submit" variant="primary" loading={busy} disabled={pin.length < 4}>Finish practice</Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
};
