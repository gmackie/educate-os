import { Table } from "@cloudflare/kumo";
import { parseCsv } from "../csv.ts";

/** Saved lab data as a table: the first row is the header. */
export const CsvTable = ({ text, caption }: { text: string; caption: string }) => {
  const [header = [], ...rows] = parseCsv(text);
  return (
    <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <Table.Header>
          <Table.Row>
            {header.map((name, i) => (
              <Table.Head key={i}>
                {name}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row, r) => (
            <Table.Row key={r}>
              {header.map((_, c) => (
                <Table.Cell key={c}>{row[c] ?? ""}</Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};
