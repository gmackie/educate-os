/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { TeacherIntake } from "./TeacherIntake";
import "../../styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
const input = (action: () => Promise<unknown>) => act(async () => { await action(); });

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

it("collects existing materials and the integration choice using the keyboard before preparing a brief", async () => {
  const onPrepare = vi.fn<(brief: string) => void>();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<TeacherIntake onPrepare={onPrepare} />));

  const submit = page.getByRole("button", { name: "Prepare my brief" });
  await expect.element(submit).toBeDisabled();
  await input(() => userEvent.fill(page.getByRole("textbox", { name: "Subject or teaching area" }), "Biology"));
  await input(() => userEvent.fill(page.getByRole("textbox", { name: "Learner level and needs (optional)" }), "Grade 9"));
  await input(() => userEvent.fill(page.getByRole("textbox", { name: "What would you like to make easier?" }), "An investigation using my existing slides"));
  await input(() => userEvent.click(page.getByRole("checkbox", { name: "Slides and presentations" })));
  const reuse = page.getByRole("radio", { name: /^Reuse my materials/ });
  await expect.element(reuse).toBeChecked();
  await input(() => userEvent.click(reuse));
  await input(() => userEvent.keyboard("{ArrowDown}"));
  const activity = page.getByRole("radio", { name: /^Create an EducateOS activity/ });
  await expect.element(activity).toBeChecked();
  await expect.element(activity).toHaveFocus();
  expect(onPrepare).not.toHaveBeenCalled();
  await input(() => userEvent.click(submit));
  expect(onPrepare).toHaveBeenCalledTimes(1);
  const brief = onPrepare.mock.calls[0][0] as string;
  expect(brief).toContain("Learner level and needs: Grade 9");
  expect(brief).toContain("Documents and worksheets; Slides and presentations");
  expect(brief).toContain("My preferred starting point: Create an EducateOS activity");
  expect(brief).toContain("Distinguish capabilities available here from proposed integrations");
});
