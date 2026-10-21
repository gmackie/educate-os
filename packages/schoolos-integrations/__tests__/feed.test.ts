import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import { loadExport } from "./fixtures/load.ts";
import { DEMOGRAPHICS_SENTINEL, PASSWORD_SENTINEL, buildExport } from "./fixtures/northfield-export.ts";

const errors = (issues: oneroster.OneRosterIssue[]) => issues.filter((i) => i.severity === "error");

/** The Northfield export with one file replaced. */
const withFile = (name: string, content: string | undefined) => {
  const files: Record<string, string> = buildExport("northfield");
  if (content === undefined) delete files[name];
  else files[name] = content;
  return files;
};

const orgs = (header: string) => withFile("orgs.csv", `${header}\r\norg-x,,,X,school,,\r\n`);

describe("readOneRosterCsv", () => {
  it("reads the Northfield export from disk with no errors", () => {
    const { feed, issues } = oneroster.readOneRosterCsv(loadExport("northfield"));
    expect(errors(issues)).toEqual([]);
    expect(feed["orgs.csv"].map((o) => o.sourcedId)).toEqual(["org-nf-district", "org-nf-high", "org-nf-middle"]);
    expect(feed["users.csv"]).toHaveLength(12);
    expect(feed["enrollments.csv"]).toHaveLength(17);
    expect(feed["users.csv"][0]?.userIds).toEqual([{ type: "idp", identifier: "nf-0001" }, { type: "sis", identifier: "1001" }]);
  });

  it("never opens demographics.csv, even when it is malformed or over the size cap", () => {
    const files = withFile("demographics.csv", `"${DEMOGRAPHICS_SENTINEL}`.repeat(1000));
    const { feed, issues } = oneroster.readOneRosterCsv(files, { maxFileBytes: 4096, maxRowsPerFile: 100 });
    expect(errors(issues)).toEqual([]);
    expect(JSON.stringify({ feed, issues })).not.toContain(DEMOGRAPHICS_SENTINEL);
  });

  it("drops columns it does not use, so passwords never leave the CSV", () => {
    const { feed } = oneroster.readOneRosterCsv(loadExport("northfield"));
    expect(JSON.stringify(feed)).not.toContain(PASSWORD_SENTINEL);
    expect(Object.keys(feed["users.csv"][0]!)).not.toContain("password");
  });

  describe("manifest", () => {
    it.each([
      ["oneroster.version,1.2", "oneroster.version,1.1", "sets oneroster.version to 1.1; expected 1.2"],
      ["file.enrollments,bulk", "file.enrollments,delta", "declares enrollments.csv as a delta; SchoolOS imports bulk exports only"],
      ["file.roles,bulk", "file.roles,absent", "must declare roles.csv as bulk"],
    ])("rejects %s replaced by %s", (from, to, message) => {
      const files = withFile("manifest.csv", buildExport("northfield")["manifest.csv"]!.replace(from, to));
      const { feed, issues } = oneroster.readOneRosterCsv(files);
      expect(errors(issues)).toEqual([{ severity: "error", file: "manifest.csv", message }]);
      expect(feed["users.csv"]).toEqual([]);
    });

    it("requires the manifest and every file it declares", () => {
      expect(errors(oneroster.readOneRosterCsv(withFile("manifest.csv", undefined)).issues)).toEqual([
        { severity: "error", file: "manifest.csv", message: "is missing from the export" },
      ]);
      expect(errors(oneroster.readOneRosterCsv(withFile("roles.csv", undefined)).issues)).toEqual([
        { severity: "error", file: "roles.csv", message: "is missing from the export" },
      ]);
    });
  });

  describe("headers", () => {

    it("accepts the specification's columns in any order, plus metadata.* extensions", () => {
      const { feed, issues } = oneroster.readOneRosterCsv(
        withFile("orgs.csv", "name,sourcedId,status,dateLastModified,type,identifier,parentSourcedId,metadata.region\r\nX,org-x,,,school,,,north\r\n"),
      );
      expect(errors(issues)).toEqual([]);
      expect(feed["orgs.csv"]).toEqual([{ sourcedId: "org-x", status: "active", name: "X", type: "school", row: 2 }]);
    });

    it.each([
      ["sourcedId,status,dateLastModified,name,type,identifier", "parentSourcedId", "is missing from the header"],
      ["sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId,region", "region", "is not a OneRoster 1.2 column"],
      ["sourcedId,status,dateLastModified,name,type,identifier,name", "name", "appears twice in the header"],
    ])("rejects the header %s", (header, column, message) => {
      const { feed, issues } = oneroster.readOneRosterCsv(orgs(header));
      expect(errors(issues)).toContainEqual({ severity: "error", file: "orgs.csv", row: 1, column, message });
      expect(feed["orgs.csv"]).toEqual([]);
    });
  });

  describe("rows", () => {
    it("reports each invalid field with its file, row and column", () => {
      const { issues } = oneroster.readOneRosterCsv(loadExport("malformed-row"));
      expect(errors(issues)).toEqual([
        { severity: "error", file: "enrollments.csv", row: 6, column: "role", message: expect.stringContaining("Invalid option") },
      ]);
    });

    it("reports a row with the wrong number of fields, and keeps reading the rest", () => {
      const sessions = buildExport("northfield")["academicSessions.csv"]!.replace("2025-2026,schoolYear", "2025-2026,extra,schoolYear");
      const { feed, issues } = oneroster.readOneRosterCsv(withFile("academicSessions.csv", sessions));
      expect(errors(issues)).toEqual([
        { severity: "error", file: "academicSessions.csv", row: 2, message: "has 10 fields; the header has 9" },
      ]);
      expect(feed["academicSessions.csv"]).toHaveLength(4);
    });

    it("validates dates, enumerations and repeated sourcedIds", () => {
      const header = "sourcedId,status,dateLastModified,title,type,startDate,endDate,parentSourcedId,schoolYear";
      const { issues } = oneroster.readOneRosterCsv(withFile("academicSessions.csv", [
        header,
        "s1,,,Fall,semester,2026-13-01,2027-01-22,,2027",
        "s2,archived,,Fall,quarter,2026-08-31,2027-01-22,,2027",
        "s3,,,Fall,semester,2026-08-31,2027-01-22,,2027",
        "s3,,,Fall,semester,2026-08-31,2027-01-22,,2027",
      ].join("\r\n")));
      expect(errors(issues).map(({ row, column }) => [row, column])).toEqual([
        [2, "startDate"],
        [3, "status"],
        [3, "type"],
        [5, "sourcedId"],
      ]);
    });

    it("reports a CSV syntax error with the line it is on", () => {
      const { issues } = oneroster.readOneRosterCsv(withFile("courses.csv", `${buildExport("northfield")["courses.csv"]}c9,,,,"Broken,X`));
      expect(errors(issues)).toEqual([
        { severity: "error", file: "courses.csv", row: 7, message: "line 7 has a quoted field that is never closed" },
      ]);
    });

    it("rejects invalid UTF-8", () => {
      const files = { ...loadExport("northfield"), "orgs.csv": new Uint8Array([0x73, 0xff, 0x0a]) };
      expect(errors(oneroster.readOneRosterCsv(files).issues)).toEqual([
        { severity: "error", file: "orgs.csv", message: "is not valid UTF-8" },
      ]);
    });
  });

  describe("limits", () => {
    it("rejects a file over the byte cap without reading it", () => {
      const { issues } = oneroster.readOneRosterCsv(loadExport("northfield"), { maxFileBytes: 1500, maxRowsPerFile: 100 });
      expect(errors(issues)).toContainEqual({ severity: "error", file: "users.csv", message: "is larger than 1500 bytes" });
    });

    it("measures the byte cap in UTF-8, not in characters", () => {
      const header = "sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId";
      const text = `${header}\r\norg-x,,,${"é".repeat(2000)},school,,\r\n`;
      const limits = { maxFileBytes: text.length + 50, maxRowsPerFile: 100 };
      expect(errors(oneroster.readOneRosterCsv(withFile("orgs.csv", text), limits).issues)).toContainEqual(
        { severity: "error", file: "orgs.csv", message: `is larger than ${limits.maxFileBytes} bytes` },
      );
    });

    it("rejects a file over the row cap", () => {
      const { issues } = oneroster.readOneRosterCsv(loadExport("northfield"), { maxFileBytes: 1 << 20, maxRowsPerFile: 10 });
      expect(errors(issues)).toEqual([
        { severity: "error", file: "users.csv", row: 12, message: "line 12 has more than 10 data rows" },
        { severity: "error", file: "roles.csv", row: 12, message: "line 12 has more than 10 data rows" },
        { severity: "error", file: "enrollments.csv", row: 12, message: "line 12 has more than 10 data rows" },
      ]);
    });
  });
});
