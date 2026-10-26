import { ClipboardText, Link, Text } from "@cloudflare/kumo";
import { SignOutIcon } from "@phosphor-icons/react";
import type { UnlinkedSignIn } from "@educateos/api-client";
import { accessLogoutHref } from "./signIn.ts";

const SignOutLink = () => (
  <Link href={accessLogoutHref()} className="flex items-center gap-2 self-start py-2">
    <SignOutIcon aria-hidden size={20} />
    Sign out
  </Link>
);

/**
 * What someone sees when they signed in but their school has not added them: the sign-in ID an
 * administrator enters to add them, ready to copy, and a way to sign out (if they used the wrong
 * account, say). Someone whose sign-in already asked to be linked (a guardian who accepted an
 * invitation) is told to wait for the school instead, as there is nothing for them to send.
 */
export const NotAddedYet = ({ signIn }: { signIn: UnlinkedSignIn }) =>
  signIn.awaitingApproval === true ? (
    <section aria-labelledby="not-added-heading" className="flex max-w-xl flex-col gap-4">
      <Text variant="heading" size="lg" as="h1">
        <span id="not-added-heading">Waiting for your school to confirm you</span>
      </Text>
      <Text>You've accepted your invitation. Your school checks your sign-in and confirms you as a guardian; then your child's classes show up here.</Text>
      <Text>There's nothing more you need to do. Come back later, or reload this page.</Text>
      <SignOutLink />
    </section>
  ) : (
    <section aria-labelledby="not-added-heading" className="flex max-w-xl flex-col gap-4">
      <Text variant="heading" size="lg" as="h1">
        <span id="not-added-heading">You're signed in, but you haven't been added to this school yet</span>
      </Text>
      <Text>Your sign-in worked. Before you can see your classes, someone at your school needs to add you to EducateOS.</Text>
      <div role="group" aria-labelledby="sign-in-id-label" className="flex flex-col gap-2">
        <Text bold as="span">
          <span id="sign-in-id-label">Your sign-in ID</span>
        </Text>
        <ClipboardText text={signIn.subject} labels={{ copyAction: "Copy your sign-in ID" }} tooltip={{ text: "Copy", copiedText: "Sign-in ID copied" }} />
        <Text variant="secondary" size="sm">Signed in through {new URL(signIn.issuer).host}</Text>
      </div>
      <Text>Send this ID to your school's administrator. They add you, then reload this page.</Text>
      <SignOutLink />
    </section>
  );
