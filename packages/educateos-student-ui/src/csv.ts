// CSV for lab data tables (RFC 4180): fields with a comma, quote or line break are quoted, and a
// quote inside one is doubled.

/** Parses CSV text into rows of fields. A trailing line break does not add an empty row. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
};

const quote = (field: string): string => (/[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field);

/** Writes rows as CSV, one line per row, ending with a line break. */
export const toCsv = (rows: readonly (readonly string[])[]): string => rows.map((row) => row.map(quote).join(",")).join("\n") + "\n";
