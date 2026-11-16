// Starting or ending a child session changes who the whole Learning Home is for, so the screens
// that do it ask the signed-in frame to read `me.get` again. App-wide by nature: it is sign-in state.
import { createContext, use } from "react";

/** Reloads the signed-in frame's `me.get`. */
export const SignInRefreshContext = createContext<() => void>(() => {});

/** The signed-in frame's reload. */
export const useRefreshSignIn = (): (() => void) => use(SignInRefreshContext);
