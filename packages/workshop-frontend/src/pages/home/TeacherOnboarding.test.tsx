// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerDraftStorageKey, readComposerDraft, writeComposerDraft } from "../../features/chat/composer/draft/composerDraft";
import { HomePage } from "./HomePage";

const state = vi.hoisted(() => ({
  api: { listModels: async () => [], newWorkspace: vi.fn<() => Pick<Overseer, "newChat" | "getMetadata"> & Disposable>() },
  navigate: vi.fn<(options: unknown) => void>(),
  addToast: vi.fn<(toast: unknown) => void>(),
  currentUser: { id: "teacher", name: "Ava" } as { id: string; name: string } | null,
  connectionPickerOpen: false,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: state.addToast, close: vi.fn<() => void>() }),
}));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: state.api, currentUser: state.currentUser }),
}));
vi.mock("../../useVendorBranding", () => ({ useVendorBranding: () => new Map() }));
vi.mock("../../CapsuleOverlay", () => ({ default: () => null }));
vi.mock("../../GatekeeperModal", () => ({ default: ({ open }: { open: boolean }) => {
  state.connectionPickerOpen = open;
  return null;
} }));
vi.mock("../../features/deployment-updates/UpdateAvailableNotice", () => ({ UpdateAvailableNotice: () => null }));
vi.mock("../../useDocumentTitle", () => ({ useDocumentTitle: () => {} }));
vi.mock("./MeshBackground", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

let root: Root | undefined;
let container: HTMLDivElement;
const homeKey = composerDraftStorageKey("teacher", "home");
const onboardingKey = composerDraftStorageKey("teacher", "teacher-onboarding");

const render = async (onboarding = true) => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<HomePage teacherOnboarding={onboarding} />));
};

const fill = async (element: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
};

const prepare = async () => {
  await fill(container.querySelector("input[required]")!, "Science");
  await fill(container.querySelector("textarea")!, "Practice ecosystem relationships");
  await act(async () => {
    container.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await new Promise(requestAnimationFrame);
  });
};

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  sessionStorage.clear();
  state.currentUser = { id: "teacher", name: "Ava" };
  state.connectionPickerOpen = false;
  vi.clearAllMocks();
});

describe("individual teacher onboarding", () => {
  it("offers every source path and wires files and connections without sending the brief", async () => {
    await render();
    await prepare();
    for (const heading of ["Lesson documents and slides", "Google Drive and Classroom", "LMS course exports"]) {
      expect(container.textContent).toContain(heading);
    }
    expect(container.textContent).toContain("Connect linked Drive files separately");
    expect(container.textContent).toContain("preview and confirmation flow");
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(fileInput, "click");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Attach files")!.click());
    expect(click).toHaveBeenCalledOnce();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Add connection")!.click());
    expect(state.connectionPickerOpen).toBe(true);
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    click.mockRestore();
  });
  it("offers a deterministic entry on the personal home", async () => {
    await render(false);
    const entry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Start with my materials")!;
    await act(async () => entry.click());
    expect(state.navigate).toHaveBeenCalledWith({ to: "/teacher-onboarding" });
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
  });

  it("prepares an editable brief without a district class, sending, or replacing the home draft", async () => {
    writeComposerDraft(homeKey, { version: 1, text: "My other project", formats: [] });
    await render();
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(container.textContent).toContain("before joining a school-managed class");
    await prepare();
    const composer = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    expect(composer.value).toContain("Subject or teaching area: Science");
    expect(composer.value).toContain("Practice ecosystem relationships");
    expect(composer.value).toContain("My preferred starting point: Reuse my materials");
    expect(composer.value).toContain("not evidence that its contents were imported or read");
    expect(composer.value).toContain("Wait for me to choose an option before building it");
    expect(document.activeElement).toBe(composer);
    await fill(composer, "My reviewed lesson request");
    expect(readComposerDraft(onboardingKey)?.text).toBe("My reviewed lesson request");
    expect(readComposerDraft(homeKey)?.text).toBe("My other project");
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("restores the reviewed brief on a fresh visit without reseeding it", async () => {
    writeComposerDraft(onboardingKey, { version: 1, text: "Keep my edited request", formats: [] });
    await render();
    expect(container.querySelector("form[aria-label='Your classroom brief']")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value).toBe("Keep my edited request");
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
  });

  it("waits for account identity before offering intake or restoring a saved brief", async () => {
    writeComposerDraft(onboardingKey, { version: 1, text: "My saved personal lesson", formats: [] });
    state.currentUser = null;
    await render();
    expect(container.textContent).toContain("Loading your classroom brief");
    expect(container.querySelector("form")).toBeNull();
    state.currentUser = { id: "teacher", name: "Ava" };
    await act(async () => root!.render(<HomePage teacherOnboarding />));
    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value).toBe("My saved personal lesson");
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
  });

  it("starts the workspace only when the teacher sends the reviewed request", async () => {
    const newChat = vi.fn<Overseer["newChat"]>(async () => 7);
    const dispose = vi.fn<() => void>();
    state.api.newWorkspace.mockReturnValue({ newChat, getMetadata: async () => ({ id: "lesson", title: "Lesson" }), [Symbol.dispose]: dispose });
    await render();
    await prepare();
    const composer = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await fill(composer, "Compare options for this lesson first.");
    expect(state.api.newWorkspace).not.toHaveBeenCalled();
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(state.api.newWorkspace).toHaveBeenCalledTimes(1);
    expect(newChat).toHaveBeenCalledWith("Compare options for this lesson first.", null, undefined, undefined, undefined);
    expect(state.navigate).toHaveBeenCalledWith({ to: "/workspace/$id", params: { id: "lesson" }, search: { chat: 7 } });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
