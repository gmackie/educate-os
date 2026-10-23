import { useRef, useState, type KeyboardEvent } from "react";
import { Badge, LayerCard, Table, Text } from "@cloudflare/kumo";
import type { Gradebook, GradebookCell, GradebookColumn, GradebookRow } from "../types.ts";
import { MARKER_LABELS, percentText, scoreText } from "./gradebookText.ts";

/** A cell a teacher opened to mark. */
export interface CellTarget {
  row: GradebookRow;
  column: GradebookColumn;
  cell: GradebookCell;
}

const MOVES: Record<string, readonly [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const CellContent = ({ cell, column, calculation }: { cell: GradebookCell; column: GradebookColumn; calculation: Gradebook["settings"]["calculation"] }) => {
  const score = scoreText(cell, column, calculation);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {score === undefined ? <><span aria-hidden>—</span><span className="sr-only">Not graded</span></> : <span>{score}</span>}
      {cell.marker === undefined ? null : <Badge variant={cell.marker === "missing" ? "warning" : "neutral"}>{MARKER_LABELS[cell.marker]}</Badge>}
      {cell.dropped ? <Badge variant="outline">Dropped</Badge> : null}
    </span>
  );
};

/**
 * A class's gradebook as a keyboard grid (the ARIA grid pattern): one row per student, whose name
 * is the row header and stays pinned while the assignments scroll sideways, then a column per
 * assignment and the totals. Arrow keys move between cells, Home and End to a row's ends (with
 * Control, to the grid's corners), and only one cell is in the tab order. Enter or Space on an
 * assignment, or a click, opens it to mark when `onOpenCell` is given.
 */
export const GradebookGrid = ({ gradebook, caption, onOpenCell }: {
  gradebook: Gradebook;
  caption: string;
  onOpenCell?: (target: CellTarget) => void;
}) => {
  const { columns, rows, settings } = gradebook;
  const totals = [
    ...settings.groups.map((group) => ({ key: group.id, label: `${group.name}`, value: (row: GradebookRow) => percentText(row.groups.find((g) => g.groupId === group.id)?.percent ?? null) })),
    { key: "unweighted", label: "Unweighted", value: (row: GradebookRow) => percentText(row.totals.unweighted) },
    ...(settings.groups.length === 0 ? [] : [{ key: "weighted", label: "Weighted", value: (row: GradebookRow) => percentText(row.totals.weighted) }]),
    { key: "final", label: "Final", value: (row: GradebookRow) => percentText(row.totals.final) },
    { key: "letter", label: "Letter", value: (row: GradebookRow) => row.totals.letter ?? "—" },
  ];
  const width = columns.length + totals.length;
  const [active, setActive] = useState({ row: 0, col: 0 });
  // The data may have shrunk since the teacher last moved; keep the tab stop on a cell that exists.
  const current = { row: Math.min(active.row, rows.length - 1), col: Math.min(active.col, width - 1) };
  const table = useRef<HTMLTableElement>(null);

  const moveTo = (row: number, col: number) => {
    const next = { row: Math.max(0, Math.min(rows.length - 1, row)), col: Math.max(0, Math.min(width - 1, col)) };
    setActive(next);
    table.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)?.focus();
  };

  const open = (row: number, col: number) => {
    const column = columns[col];
    if (onOpenCell === undefined || column === undefined) return;
    onOpenCell({ row: rows[row]!, column, cell: rows[row]!.cells[col]! });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const move = MOVES[event.key];
    if (move !== undefined) moveTo(current.row + move[0], current.col + move[1]);
    else if (event.key === "Home") moveTo(event.ctrlKey ? 0 : current.row, 0);
    else if (event.key === "End") moveTo(event.ctrlKey ? rows.length - 1 : current.row, width - 1);
    else if (event.key === "Enter" || event.key === " ") open(current.row, current.col);
    else return;
    event.preventDefault();
  };

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table ref={table} role="grid" aria-readonly={onOpenCell === undefined}>
        <caption className="sr-only">{caption}</caption>
        <Table.Header>
          <Table.Row>
            <Table.Head sticky="left">Student</Table.Head>
            {columns.map((column) => {
              const group = settings.groups.find((g) => g.id === column.groupId);
              return (
                <Table.Head key={column.assignmentId}>
                  <span className="flex min-w-32 flex-col">
                    <span>{column.title}</span>
                    <Text variant="secondary" size="xs" as="span">
                      {[group?.name, column.pointsPossible === null ? undefined : `out of ${column.pointsPossible}`].filter((part) => part !== undefined).join(" · ")}
                    </Text>
                  </span>
                </Table.Head>
              );
            })}
            {totals.map((total) => <Table.Head key={total.key}>{total.label}</Table.Head>)}
          </Table.Row>
        </Table.Header>
        <Table.Body onKeyDown={onKeyDown}>
          {rows.map((row, r) => {
            const cellProps = (c: number) => ({
              role: "gridcell",
              "data-cell": `${r}:${c}`,
              tabIndex: current.row === r && current.col === c ? 0 : -1,
              onFocus: () => setActive({ row: r, col: c }),
              className: "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand",
            });
            return (
              <Table.Row key={row.studentPrincipalId}>
                <Table.Head sticky="left" role="rowheader">{row.displayName}</Table.Head>
                {row.cells.map((cell, c) => (
                  <Table.Cell
                    key={cell.assignmentId}
                    {...cellProps(c)}
                    {...(onOpenCell === undefined ? {} : { "aria-haspopup": "dialog" as const, onClick: () => open(r, c) })}
                  >
                    <CellContent cell={cell} column={columns[c]!} calculation={settings.calculation} />
                  </Table.Cell>
                ))}
                {totals.map((total, t) => (
                  <Table.Cell key={total.key} {...cellProps(columns.length + t)}>{total.value(row)}</Table.Cell>
                ))}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </LayerCard>
  );
};
