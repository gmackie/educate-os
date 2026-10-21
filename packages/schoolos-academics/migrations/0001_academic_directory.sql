-- The academic directory on D1 (SCHO-47): one district per database, read and written by
-- `D1AcademicStore`. Each record is stored as the canonical JSON of its contract schema, which is
-- what the store parses and trusts; `position` keeps the order the directory lists records in.

-- The district itself and the directory's version, in exactly one row.
CREATE TABLE academic_directory (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  district_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  district_json TEXT NOT NULL
);

CREATE TABLE academic_schools (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE academic_terms (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE academic_courses (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE academic_offerings (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE academic_principals (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE academic_enrollments (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);
-- A role assignment has no ID of its own; its key is its canonical JSON.
CREATE TABLE academic_role_assignments (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL);

-- The optimistic concurrency check. A commit's batch starts by inserting the version it was planned
-- against into this view. The trigger aborts the statement, and with it the whole batch, unless
-- that is still the stored version, and otherwise advances the version. The check and the writes
-- therefore commit together or not at all, with no window between them.
CREATE VIEW academic_directory_commit AS SELECT version AS expected_version FROM academic_directory;

CREATE TRIGGER academic_directory_commit_guard INSTEAD OF INSERT ON academic_directory_commit
BEGIN
  SELECT RAISE(ABORT, 'schoolos: academic directory version conflict')
  WHERE NEW.expected_version IS NOT (SELECT version FROM academic_directory WHERE singleton = 1);
  UPDATE academic_directory SET version = version + 1 WHERE singleton = 1;
END;
