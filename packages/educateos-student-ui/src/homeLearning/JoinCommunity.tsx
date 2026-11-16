import { useState } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";
import type { UnlinkedSignIn } from "@educateos/api-client";
import { useApi, useQuery } from "../api.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { NotAddedYet } from "../NotAddedYet.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { useRefreshSignIn } from "./signInRefresh.ts";

/**
 * Someone signed in who isn't anyone here yet. Where the installation is a community that lets
 * families sign up (ADR-0016), they join with their name; where it asks an organizer to approve,
 * they wait. Anywhere else, the school's "not added yet" page.
 */
export const JoinCommunity = ({ signIn }: { signIn: UnlinkedSignIn }) => {
  const api = useApi();
  const refresh = useRefreshSignIn();
  const [community] = useQuery("community", (client) => client.call("onboarding.community"));
  const [name, setName] = useState("");
  const [waiting, setWaiting] = useState(signIn.awaitingApproval === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (community.status === "loading") return <LoadingSkeleton label="Opening your Learning Home" />;
  const signup = community.status === "ready" && community.data.homeLearning ? community.data.signup : null;
  if (signup === null || signup === "invite-only") return <NotAddedYet signIn={signIn} />;
  if (waiting) {
    return (
      <section aria-labelledby="join-heading" className="flex max-w-xl flex-col gap-4">
        <PageHeading id="join-heading">Waiting for the community to welcome you</PageHeading>
        <Text>An organizer checks each new family. Once they have, reload this page to set up home learning.</Text>
      </section>
    );
  }
  return (
    <section aria-labelledby="join-heading" className="flex max-w-xl flex-col gap-4">
      <PageHeading id="join-heading">Join this learning community</PageHeading>
      <Text>Set up short reading and number practice for your children, and see what they can do. Your family's practice is visible only to you.</Text>
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(false);
        api.call("onboarding.joinCommunity", { body: { displayName: name.trim() } }).then(({ outcome }) => {
          if (outcome === "joined") refresh();
          else setWaiting(true);
          setBusy(false);
        }, () => {
          setError(true);
          setBusy(false);
        });
      }}>
        <Input label="Your name" description="How the community's organizers see you." maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
        {error ? <p role="alert" className="text-kumo-danger">We couldn't add you. Try again in a moment.</p> : null}
        <Button type="submit" variant="primary" loading={busy} disabled={name.trim() === ""} className="self-start">{signup === "open" ? "Join" : "Ask to join"}</Button>
      </form>
    </section>
  );
};
