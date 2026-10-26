// What the School app's frame may ask of its account (SCHO-218). Types only, so the DOM build of the
// frame and the Worker share them.

/** One district API response, which the frame's fetch rebuilds into a `Response`. */
export type DistrictResponse = {
  status: number;
  /** The response body, as text: every district API response is JSON. */
  body: string;
  /** The district's correlation ID for the request, for an administrator to find it by. */
  correlationId: string | null;
};

/** The account's capability for its School app. */
export interface SchoolAppApi {
  /** The district's public origin, for links that leave the app, or null if this deployment does not say. */
  districtOrigin(): Promise<string | null>;
  /**
   * Sends one request to the district's `/api` surface as the account's own person, exactly as
   * their own sign-in to the district would: the same routes, rules and refusals.
   */
  request(method: "GET" | "POST", path: string, body: string | null): Promise<DistrictResponse>;
}
