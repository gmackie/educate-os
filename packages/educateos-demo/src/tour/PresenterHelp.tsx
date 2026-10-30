import { Button, Popover, Text } from "@cloudflare/kumo";
import { QuestionIcon } from "@phosphor-icons/react";
import { PRESENTER_KEYS } from "./presenter.ts";

interface PresenterHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Presenter mode's "?": its keyboard shortcuts, which the "?" key also opens. */
export const PresenterHelp = ({ open, onOpenChange }: PresenterHelpProps) => (
  <Popover open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger render={<Button size="sm" variant="ghost" shape="square" icon={<QuestionIcon aria-hidden />} aria-label="Presenter shortcuts" />} />
    <Popover.Content>
      <Popover.Title>Presenter shortcuts</Popover.Title>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        {PRESENTER_KEYS.map(({ key, does }) => (
          <div key={key} className="contents">
            <dt><kbd className="rounded border border-kumo-line px-1.5 font-mono text-sm">{key}</kbd></dt>
            <dd><Text size="sm">{does}</Text></dd>
          </div>
        ))}
      </dl>
      <Popover.Description>
        <span className="mt-3 block max-w-xs">Keys do nothing while you type in a field. “Jump” runs the first sync for you when a step needs it; “Start over” boots a fresh, unsynced Cedar Valley.</span>
      </Popover.Description>
    </Popover.Content>
  </Popover>
);
