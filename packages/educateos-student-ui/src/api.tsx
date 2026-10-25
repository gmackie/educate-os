import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { DistrictApiError, type DistrictApiClient } from "@educateos/api-client";
import { behindAccess } from "./signIn.ts";

const ApiContext = createContext<DistrictApiClient | null>(null);

/** Makes the district API client available to every screen. */
export const ApiProvider = ({ client, children }: { client: DistrictApiClient; children: ReactNode }) => (
  <ApiContext value={client}>{children}</ApiContext>
);

/** The district API client. */
export const useApi = (): DistrictApiClient => {
  const client = use(ApiContext);
  if (client === null) throw new Error("useApi needs an ApiProvider");
  return client;
};

/** Where a {@link useQuery} load is. */
export type Query<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: T };

type Settled<T> = { key: string; result: Query<T> };

/**
 * Loads data from the district API and keeps it while the component is mounted. `key` must name
 * everything `load` reads: a new key starts a new load and drops the old result, so a screen never
 * shows one course's data under another's heading. `reload` loads again under the same key and
 * keeps showing the current data until the new data arrives.
 */
export const useQuery = <T,>(key: string, load: (api: DistrictApiClient) => Promise<T>): [Query<T>, () => void] => {
  const api = useApi();
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | undefined>(undefined);

  useEffect(() => {
    let current = true;
    load(api).then(
      (data) => current && setSettled({ key, result: { status: "ready", data } }),
      (error: unknown) => current && setSettled({ key, result: { status: "error", error } }),
    );
    return () => {
      current = false;
    };
    // `key` stands for `load`'s inputs; `load` itself is a new closure on every render.
  }, [api, key, version]);

  const result: Query<T> = settled !== undefined && settled.key === key ? settled.result : { status: "loading" };
  return [result, () => setVersion((v) => v + 1)];
};

/** Whether an API call failed because the thing does not exist or is not visible to the caller. */
export const isNotFound = (error: unknown): boolean => error instanceof DistrictApiError && error.code === "not-found";

/**
 * A message a student can act on. Server messages are shown only for the codes whose messages are
 * written for the person (a conflict such as "the class has not closed yet"); everything else gets
 * a plain sentence, so no internal term or identifier reaches the screen.
 */
export const messageFor = (error: unknown): string => {
  if (!(error instanceof DistrictApiError)) return "We couldn't reach your school. Check your connection and try again.";
  switch (error.code) {
    // Someone the school has not added yet is shown `NotAddedYet` instead; this is a sign-in that
    // ended or did not verify. Behind Access, reloading signs in again; otherwise only a new link does.
    case "unauthenticated":
      return behindAccess() ? "Your sign-in has ended. Reload this page to sign in again." : "Your sign-in has ended. Open your sign-in link again.";
    case "forbidden":
      return "You don't have access to this.";
    case "not-found":
      return "We couldn't find that.";
    case "conflict":
      return error.message;
    case "validation-failed":
      return "Something in this work couldn't be accepted. Check it and try again.";
    default:
      return "Something went wrong at your school's end. Try again in a moment.";
  }
};
