// Chooses an option of a Kumo Select in jsdom, as an administrator would with a pointer. Not a test file.
import { expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/dom";
import type { UserEvent } from "@testing-library/user-event";

/** The trigger of the select labelled `name`, within `scope`. */
export const selectTrigger = (name: string | RegExp, scope: HTMLElement = document.body): HTMLElement =>
  within(scope).queryByRole("combobox", { name }) ?? within(scope).getByRole("button", { name });

/** Opens the select labelled `name` and chooses the option labelled `option`; the trigger then shows it. */
export async function chooseOption(user: UserEvent, name: string | RegExp, option: string, scope?: HTMLElement): Promise<void> {
  const trigger = selectTrigger(name, scope);
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
  await waitFor(() => expect(trigger.textContent).toContain(option));
}
