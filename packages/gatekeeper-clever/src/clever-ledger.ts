// One Durable Object per Clever district, named by the district's Clever ID, holding what the
// whole deployment shares about that district:
//
// - The assignment registry: every LMS Connect assignment created through this gatekeeper, by
//   section. LMS Connect has no listing of a section's assignments, and only these are visible to
//   agents: teachers and administrators list and grade them, and students see them as the work
//   EducateOS posted. A teacher's work made in the LMS directly is never here.
// - The district audit log: every read and change made through a district administrator's
//   district-wide connection, with who, what, which record and when.
//
// Reached only from this Worker's own code, through `ctx.exports`; it has no binding and no HTTP
// surface.

import { DurableObject } from "cloudflare:workers";
import { createLogger } from "@gadgets/observability/logger";
import { VENDOR_ID, type Env } from "./clever-env";

const logger = createLogger<{ vendorId: string; action: string; target: string; userId: string }>({
  component: "gatekeeper.clever.audit", vendorId: VENDOR_ID,
});

/** One assignment created through this gatekeeper. */
export type RegisteredAssignment = {
  sectionId: string;
  assignmentId: string;
  title: string;
  description?: string;
  pointsPossible: number;
  /** ISO 8601. */
  dueDate?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** The Clever user ID of whoever's connection created it. */
  createdBy: string;
};

/** One entry of the district's audit log. */
export type AuditEntry = {
  /** Increasing. */
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  /** The Clever user ID of the administrator the connection is for. */
  userId: string;
  /** What was done, e.g. `read:roster`, `request:set-grade`, `applied:set-grade`. */
  action: string;
  /** The records it was done to, by Clever ID, e.g. `section:<id>/assignment:<id>`. */
  target: string;
};

/** The most audit entries one read returns. */
const MAX_AUDIT_PAGE = 500;

export class CleverDistrictLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS assignments (
      section_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      points_possible REAL NOT NULL,
      due_date TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (section_id, assignment_id)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL
    )`);
  }

  /** Records an assignment just created. Recording one already known changes nothing. */
  recordAssignment(assignment: RegisteredAssignment): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO assignments
        (section_id, assignment_id, title, description, points_possible, due_date, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      assignment.sectionId, assignment.assignmentId, assignment.title, assignment.description ?? null,
      assignment.pointsPossible, assignment.dueDate ?? null, assignment.createdAt, assignment.createdBy);
  }

  /** The section's registered assignments, oldest first. */
  listAssignments(sectionId: string): RegisteredAssignment[] {
    return this.ctx.storage.sql.exec<AssignmentRow>(
      "SELECT * FROM assignments WHERE section_id = ? ORDER BY created_at, assignment_id", sectionId,
    ).toArray().map(fromRow);
  }

  /** One registered assignment of the section, or null. */
  getAssignment(sectionId: string, assignmentId: string): RegisteredAssignment | null {
    const [row] = this.ctx.storage.sql.exec<AssignmentRow>(
      "SELECT * FROM assignments WHERE section_id = ? AND assignment_id = ?", sectionId, assignmentId,
    ).toArray();
    return row === undefined ? null : fromRow(row);
  }

  /** Appends to the audit log, and logs the entry, which names records by ID only. */
  appendAudit(entry: { userId: string; action: string; target: string }): AuditEntry {
    const at = Date.now();
    const [row] = this.ctx.storage.sql.exec<{ seq: number }>(
      "INSERT INTO audit (at, user_id, action, target) VALUES (?, ?, ?, ?) RETURNING seq",
      at, entry.userId, entry.action, entry.target,
    ).toArray();
    logger.info("district-wide Clever access", {
      event: "clever.district.audit", action: entry.action, target: entry.target, userId: entry.userId,
    });
    return { seq: row!.seq, at, ...entry };
  }

  /** The audit log, newest first, `limit` entries at most, before `beforeSeq` when given. */
  listAudit(options: { limit?: number; beforeSeq?: number } = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(MAX_AUDIT_PAGE, Math.floor(options.limit ?? 100)));
    const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER;
    return this.ctx.storage.sql.exec<AuditRow>(
      "SELECT seq, at, user_id, action, target FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?", before, limit,
    ).toArray().map(row => ({ seq: row.seq, at: row.at, userId: row.user_id, action: row.action, target: row.target }));
  }
}

type AssignmentRow = {
  section_id: string;
  assignment_id: string;
  title: string;
  description: string | null;
  points_possible: number;
  due_date: string | null;
  created_at: number;
  created_by: string;
};

type AuditRow = { seq: number; at: number; user_id: string; action: string; target: string };

function fromRow(row: AssignmentRow): RegisteredAssignment {
  return {
    sectionId: row.section_id,
    assignmentId: row.assignment_id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    pointsPossible: row.points_possible,
    ...(row.due_date === null ? {} : { dueDate: row.due_date }),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
