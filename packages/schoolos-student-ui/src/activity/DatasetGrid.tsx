import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@cloudflare/kumo";
import { MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { parseCsv, toCsv } from "../csv.ts";
import type { DatasetColumn } from "./workMode.ts";

/** A column's heading, with its unit: "Mass change (%)". */
export const columnHeading = (column: DatasetColumn): string => (column.unit === undefined ? column.name : `${column.name} (${column.unit})`);

/** The data rows of saved CSV, each padded or cut to the step's columns. The first row is the header. */
const dataRows = (csv: string, width: number): string[][] => {
  const rows = parseCsv(csv).slice(1).map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
  return rows.length === 0 ? [Array.from({ length: width }, () => "")] : rows;
};

/**
 * An editable table for lab data, saved as CSV with the step's column headings. It is one stop in
 * the Tab order: inside it the arrow keys move between cells (left and right once the caret is at
 * the edge of the text) and Enter moves down, as in a spreadsheet.
 */
export const DatasetGrid = ({ label, columns, value, readOnly, onChange }: {
  label: string;
  columns: DatasetColumn[];
  value: string;
  readOnly: boolean;
  onChange: (csv: string) => void;
}) => {
  const headings = columns.map(columnHeading);
  const rows = dataRows(value, columns.length);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const cells = useRef(new Map<string, HTMLInputElement>());
  const current = { row: Math.min(active.row, rows.length - 1), col: Math.min(active.col, columns.length - 1) };

  const commit = (next: string[][]) => onChange(toCsv([headings, ...next]));
  const moveTo = (row: number, col: number) => {
    if (row < 0 || row >= rows.length || col < 0 || col >= columns.length) return;
    setActive({ row, col });
    cells.current.get(`${row}:${col}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    const move: Partial<Record<string, [number, number] | false>> = {
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      Enter: [row + 1, col],
      ArrowLeft: atStart && [row, col - 1],
      ArrowRight: atEnd && [row, col + 1],
    };
    const target = move[event.key];
    if (!target) return;
    event.preventDefault();
    moveTo(...target);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
        <table role="grid" aria-label={label} aria-readonly={readOnly} className="w-full border-collapse text-left">
          <thead>
            <tr>
              {headings.map((heading) => (
                <th key={heading} scope="col" className="border-b border-kumo-hairline bg-kumo-elevated px-3 py-2 text-sm font-semibold">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} role="gridcell" className="border-b border-kumo-hairline p-1">
                    <input
                      ref={(element) => {
                        if (element === null) cells.current.delete(`${r}:${c}`);
                        else cells.current.set(`${r}:${c}`, element);
                      }}
                      aria-label={`Row ${r + 1}, ${headings[c]}`}
                      tabIndex={current.row === r && current.col === c ? 0 : -1}
                      value={cell}
                      readOnly={readOnly}
                      onFocus={() => setActive({ row: r, col: c })}
                      onKeyDown={(event) => onKeyDown(event, r, c)}
                      onChange={(event) => commit(rows.map((values, i) => (i === r ? values.map((v, j) => (j === c ? event.target.value : v)) : values)))}
                      className="w-full min-w-24 rounded bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-kumo-focus"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {readOnly ? null : (
        <div className="flex gap-2">
          <Button size="sm" icon={<PlusIcon aria-hidden />} onClick={() => commit([...rows, columns.map(() => "")])}>
            Add row
          </Button>
          <Button size="sm" icon={<MinusIcon aria-hidden />} disabled={rows.length <= 1} onClick={() => commit(rows.slice(0, -1))}>
            Remove last row
          </Button>
        </div>
      )}
    </div>
  );
};
