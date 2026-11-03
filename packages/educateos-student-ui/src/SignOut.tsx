import { Button, Link } from "@cloudflare/kumo";
import { SignOutIcon } from "@phosphor-icons/react";
import { accessLogoutHref, behindAccess, forgetSignIn } from "./signIn.ts";

/** On a phone the header has room only for the control's icon, so its name is for screen readers there. */
const Label = () => <span className="max-md:sr-only">Sign out</span>;

/**
 * Signs out. Behind Cloudflare Access that is Access's logout page; with a development sign-in
 * link it forgets the tab's token and starts again, where the sign-in screen asks for a new link.
 */
export const SignOut = () =>
  behindAccess() ? (
    <Link href={accessLogoutHref()} variant="plain" className="flex items-center gap-2 py-2">
      <SignOutIcon aria-hidden size={20} />
      <Label />
    </Link>
  ) : (
    <Button
      variant="ghost"
      icon={<SignOutIcon aria-hidden />}
      onClick={() => {
        forgetSignIn();
        window.location.assign("/");
      }}
    >
      <Label />
    </Button>
  );
