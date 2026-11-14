import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PageHeading } from "./PageHeading.tsx";
import { documentTitle, useRouteTitle } from "./pageTitle.ts";

let mounted: Root | undefined;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = undefined;
  document.body.replaceChildren();
  document.title = "";
});

const mount = (element: React.ReactNode) => {
  const container = document.body.appendChild(document.createElement("div"));
  mounted = createRoot(container);
  act(() => mounted!.render(element));
};

describe("documentTitle", () => {
  it("names the screen first, down to the app, skipping empty parts", () => {
    expect(documentTitle("Gradebook", "English 9", "Teacher Studio")).toBe("Gradebook · English 9 · Teacher Studio");
    expect(documentTitle("", "Learning Home")).toBe("Learning Home");
  });
});

/** An app whose route names itself, then shows a screen that loads before naming itself too. */
let go: (route: string) => void = () => {};
let load: () => void = () => {};
const TestApp = () => {
  const [route, setRoute] = useState("/grades");
  const [loaded, setLoaded] = useState(false);
  go = (next) => {
    setRoute(next);
    setLoaded(false);
  };
  load = () => setLoaded(true);
  useRouteTitle(documentTitle(route === "/grades" ? "My grades" : "Class", "Learning Home"), route);
  if (!loaded) return <p role="status">Loading</p>;
  return route === "/grades"
    ? <PageHeading app="Learning Home">My grades</PageHeading>
    : <PageHeading app="Learning Home" title="Biology · Class">Biology</PageHeading>;
};

describe("page titles", () => {
  it("names the route while its screen loads, then the screen once it shows", () => {
    mount(<TestApp />);
    expect(document.title).toBe("My grades · Learning Home");

    act(() => go("/courses/bio"));
    expect(document.title).toBe("Class · Learning Home");
    act(() => load());
    expect(document.title).toBe("Biology · Class · Learning Home");

    act(() => go("/grades"));
    expect(document.title).toBe("My grades · Learning Home");
  });

  it("moves focus to the new screen's heading when it opens", () => {
    mount(<TestApp />);
    act(() => load());
    const heading = document.querySelector("h1");
    expect(heading?.textContent).toBe("My grades");
    expect(document.activeElement).toBe(heading);
  });
});
