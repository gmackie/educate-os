import { useState } from "react";
import { Button, InputArea, Text } from "@cloudflare/kumo";
import { CheckCircle } from "@phosphor-icons/react";
import { formatDateTime } from "../dates.ts";
import type { WeeklyNoteView } from "../types.ts";

/** The longest weekly note the district stores, in characters. */
const MAX_NOTE_LENGTH = 2_000;

const weekStart = (week: string): string => {
  const [year, number] = week.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() + ((number - 1) * 7 - ((jan4.getUTCDay() || 7) - 1)) * 86_400_000);
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", timeZone: "UTC" }).format(monday);
};

/**
 * The class's note to families for the week the next family digest covers. Saving empty text
 * removes it. Families of students in the class read it in their weekly email. While what is typed
 * is what was saved, it says so, and when.
 */
export const WeeklyNoteForm = ({ current, saving, onSave }: { current: WeeklyNoteView; saving: boolean; onSave: (text: string) => Promise<boolean> }) => {
  const [text, setText] = useState(current.note?.text ?? "");
  return (
    <form
      aria-label="Note to families"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(text);
      }}
    >
      <Text variant="secondary">
        {`Included in the weekly family email for the week of ${weekStart(current.week)}. Families see it as written.`}
      </Text>
      <InputArea label="Note for the week" autoResize minRows={3} maxLength={MAX_NOTE_LENGTH} value={text} onValueChange={setText} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={saving}>
          {text.trim() === "" && current.note !== null ? "Remove note" : "Save note"}
        </Button>
        {current.note !== null && text.trim() === current.note.text && (
          <Text variant="secondary" size="sm" as="span">
            <span className="inline-flex items-center gap-1">
              <CheckCircle aria-hidden />
              {`Saved ${formatDateTime(current.note.updated.at)}`}
            </span>
          </Text>
        )}
      </div>
    </form>
  );
};
