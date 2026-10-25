import { ClipboardText, Link, Text } from "@cloudflare/kumo";
import { SignOutIcon } from "@phosphor-icons/react";
import type { UnlinkedSignIn } from "@schoolos/api-client";

// Absolute, so the router's link component leaves it to the browser: Access serves it, not the app.
const signOutHref = () => new URL("/cdn-cgi/access/logout", window.location.origin).href;

/**
 * What someone sees when they signed in but their school has not added them: the sign-in ID an
 * administrator enters to add them, ready to copy, and a way to sign out (if they used the wrong
 * account, say).
 */
export const NotAddedYet = ({ signIn }: { signIn: UnlinkedSignIn }) => (
  <section aria-labelledby="not-added-heading" className="flex max-w-xl flex-col gap-4">
    <Text variant="heading" size="lg" as="h1">
      <span id="not-added-heading">You're signed in, but you haven't been added to this school yet</span>
    </Text>
    <Text>Your sign-in worked. Before you can see your classes, someone at your school needs to add you to SchoolOS.</Text>
    <div role="group" aria-labelledby="sign-in-id-label" className="flex flex-col gap-2">
      <Text bold as="span">
        <span id="sign-in-id-label">Your sign-in ID</span>
      </Text>
      <ClipboardText text={signIn.subject} labels={{ copyAction: "Copy your sign-in ID" }} tooltip={{ text: "Copy", copiedText: "Sign-in ID copied" }} />
      <Text variant="secondary" size="sm">Signed in through {new URL(signIn.issuer).host}</Text>
    </div>
    <Text>Send this ID to your school's administrator. They add you, then reload this page.</Text>
    <Link href={signOutHref()} className="flex items-center gap-2 self-start py-2">
      <SignOutIcon aria-hidden size={20} />
      Sign out
    </Link>
  </section>
);
