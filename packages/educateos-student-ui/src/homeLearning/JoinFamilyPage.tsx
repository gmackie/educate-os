import { useEffect, useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { messageFor, useApi } from "../api.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { HOME_PATH, JOIN_FAMILY_PATH } from "./paths.ts";
import { useRefreshSignIn } from "./signInRefresh.ts";
import { useFamily } from "./useFamily.ts";

/**
 * Where another grown-up's invitation link lands (ADR-0016). The token is read once and taken out of
 * the address bar, so it doesn't stay in history. Joining gives this adult the same view and
 * controls as every other grown-up of the family.
 */
export const JoinFamilyPage = () => {
  const api = useApi();
  const navigate = useNavigate();
  const refresh = useRefreshSignIn();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [token] = useState(() => new URLSearchParams(hash).get("invitation") ?? undefined);
  const [home] = useFamily();
  const [state, setState] = useState<{ status: "idle" | "sending" } | { status: "failed"; message: string }>({ status: "idle" });

  useEffect(() => {
    if (hash !== "") void navigate({ to: JOIN_FAMILY_PATH, hash: "", replace: true });
  }, [hash]);

  const hasFamily = home.status === "ready" && home.data.family !== null;
  return (
    <section aria-labelledby="join-family" className="flex max-w-xl flex-col gap-4">
      <PageHeading id="join-family">Join your family's home learning</PageHeading>
      {token === undefined ? (
        <Text>This page needs the invitation link another grown-up sent you. Open the link again, or ask them for a new one.</Text>
      ) : hasFamily ? (
        <Text>You already belong to a family here. To join this one instead, leave your current family from Family settings first, then open the link again.</Text>
      ) : (
        <>
          <Text>You'll see the same children, plans and progress as the grown-up who invited you, and you can change them too.</Text>
          {state.status === "failed" ? <div role="alert"><Banner variant="error" title="That didn't work" description={state.message} /></div> : null}
          <Button variant="primary" className="self-start" loading={state.status === "sending"} onClick={() => {
            setState({ status: "sending" });
            api.call("family.acceptInvitation", { body: { token } }).then(() => {
              refresh();
              void navigate({ to: HOME_PATH, replace: true });
            }, (caught: unknown) => setState({ status: "failed", message: messageFor(caught) }));
          }}>Join the family</Button>
        </>
      )}
    </section>
  );
};
