import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { PlayIcon } from "@phosphor-icons/react";
import { useApi } from "../api.tsx";
import { messageFor } from "../api.tsx";
import { useRefreshSignIn } from "./signInRefresh.ts";

/**
 * Hands this device to a child: starts a child session, after which the Learning Home shows only
 * their practice until a grown-up finishes it with the family PIN.
 */
export const StartPracticeButton = ({ learnerId, displayName, disabled }: { learnerId: string; displayName: string; disabled: boolean }) => {
  const api = useApi();
  const refresh = useRefreshSignIn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <div className="flex flex-col gap-2">
      <Button variant="primary" icon={<PlayIcon aria-hidden />} loading={busy} disabled={disabled} onClick={() => {
        setBusy(true);
        setError(undefined);
        api.call("family.startChildSession", { params: { learnerId }, body: {} }).then(
          () => refresh(),
          (caught: unknown) => {
            setError(messageFor(caught));
            setBusy(false);
          },
        );
      }}>
        {`Hand over to ${displayName}`}
      </Button>
      {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
    </div>
  );
};
