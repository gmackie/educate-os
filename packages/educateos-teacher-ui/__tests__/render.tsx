import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import type { DistrictApiClient } from "@educateos/api-client";
import { App } from "../src/App.tsx";
import { DistrictApiProvider } from "../src/DistrictApi.tsx";

let mounted: { root: Root; container: HTMLElement } | undefined;

afterEach(() => {
  if (mounted !== undefined) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = undefined;
  }
  window.location.hash = "";
});

/** Renders Teacher Studio over `client`, at `hash`. */
export const renderApp = async (client: DistrictApiClient, hash = "#/") => {
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<DistrictApiProvider client={client}><App /></DistrictApiProvider>));
  mounted = { root, container };
  return userEvent.setup();
};

/** Follows the URL's hash change, which jsdom reports asynchronously. */
export const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits until the screen's main heading reads `name`. */
export const onScreen = (name: string | RegExp) => waitFor(() => screen.getByRole("heading", { level: 1, name }));
