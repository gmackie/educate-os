// Development sign-in: `?token=<a token the harness printed>` signs this tab in. The token moves
// into sessionStorage and out of the address bar at once, so it never sits in history, a bookmark
// or a screenshot. Behind Cloudflare Access (main.tsx) no token is taken: Access attaches the
// credential itself.

/** Whether this build is served behind Cloudflare Access (`VITE_CF_ACCESS_MODE=true`), which signs requests itself. */
export const behindAccess = (): boolean => import.meta.env.VITE_CF_ACCESS_MODE === "true";

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
