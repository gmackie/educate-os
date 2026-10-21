// Development sign-in: `?token=<a token the harness printed>` signs this tab in. The token moves
// into sessionStorage and out of the address bar at once, so it never sits in history, a bookmark
// or a screenshot. Real sign-in arrives with the kernel seam, which attaches the credential itself.

const TOKEN_KEY = "schoolos.student.token";

/** Takes a `?token=` sign-in from `location`, if there is one, and returns the tab's current token. */
export const takeSignIn = (location: Location, history: History): string | undefined => {
  const url = new URL(location.href);
  const offered = url.searchParams.get("token");
  if (offered !== null) {
    url.searchParams.delete("token");
    history.replaceState(history.state, "", url);
    if (offered !== "") sessionStorage.setItem(TOKEN_KEY, offered);
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
};
