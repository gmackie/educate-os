import { useEffect, useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { DistrictApiError } from "@schoolos/api-client";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { INVITATION_PATH } from "../router.tsx";

type Redeeming =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; outcome: "awaiting-approval" | "joined" }
  | { status: "failed"; message: string };

const DONE = {
  "awaiting-approval": "Thanks. Your school will check your sign-in and confirm you as a guardian. Your child's classes show up here once they have.",
  joined: "Thanks. Your school will confirm this child for you, and they'll show up with your other children once it has.",
} as const;

/**
 * Where a guardian's invitation link lands (ADR-0012). The guardian is signed in but may not be
 * anyone on SchoolOS yet, so this page needs no account: it redeems the invitation, which only asks
 * the school to approve the sign-in and confirm the guardian. The token is taken out of the address
 * bar as soon as it is read, so it does not stay in history.
 */
export const InvitationPage = () => {
  const api = useApi();
  const announce = useAnnounce();
  const navigate = useNavigate();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const [token] = useState(() => new URLSearchParams(hash).get("invitation") ?? undefined);
  const [state, setState] = useState<Redeeming>({ status: "idle" });

  useEffect(() => {
    if (hash !== "") void navigate({ to: INVITATION_PATH, hash: "", replace: true });
  }, [hash]);

  const redeem = async (invitation: string) => {
    setState({ status: "sending" });
    try {
      const { outcome } = await api.call("onboarding.redeemGuardianInvitation", { body: { token: invitation } });
      setState({ status: "done", outcome });
      announce("Invitation accepted");
    } catch (error) {
      // These answers are written for the person holding the link: it was used, it expired, or the sign-in is someone else's.
      const message = error instanceof DistrictApiError && ["not-found", "conflict", "forbidden"].includes(error.code) ? error.message : messageFor(error);
      setState({ status: "failed", message });
      announce("The invitation could not be accepted");
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Text variant="heading" size="lg" as="h1">Connect to your child's classes</Text>
      {token === undefined ? (
        <Text>Open the invitation link your school gave you. It works once.</Text>
      ) : state.status === "done" ? (
        <div role="status">
          <Banner variant="default" icon={<CheckCircleIcon weight="fill" />} title="Invitation accepted" description={DONE[state.outcome]} />
        </div>
      ) : (
        <>
          <Text>Your school invited you to follow a child's classes, assignments, feedback and grades. You can't change anything, and you won't see the child's own work.</Text>
          {state.status === "failed" ? (
            <div role="alert">
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="The invitation could not be accepted" description={state.message} />
            </div>
          ) : null}
          <div>
            <Button variant="primary" loading={state.status === "sending"} onClick={() => void redeem(token)}>Accept invitation</Button>
          </div>
        </>
      )}
    </div>
  );
};
