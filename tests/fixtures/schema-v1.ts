/**
 * Frozen, hand-written schema-1 fixture from the pre-U2 store format.
 * Keep this DDL independent of src/job-store.ts so schema refusal tests cannot
 * accidentally regenerate an old database from current production code.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_V1_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE jobs (
  creation_ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  owner_uuid TEXT NOT NULL,
  owner_session_path TEXT NOT NULL,
  runner_token_hash TEXT NOT NULL,
  request_namespace TEXT NOT NULL,
  request_key TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  deadline_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'claimed', 'settled')),
  UNIQUE (owner_uuid, request_namespace, request_key)
);
CREATE INDEX jobs_owner_idx ON jobs (owner_uuid, creation_ordinal);
CREATE TABLE job_claims (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  claim_id TEXT NOT NULL UNIQUE,
  claimed_at_ms INTEGER NOT NULL,
  heartbeat_counter INTEGER NOT NULL DEFAULT 0,
  heartbeat_at_ms INTEGER
);
CREATE TABLE job_results (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision INTEGER NOT NULL,
  launch TEXT NOT NULL,
  shell_code INTEGER,
  shell_signal TEXT,
  cleanup_state TEXT NOT NULL,
  cleanup_term_observation TEXT,
  cleanup_kill_intent INTEGER NOT NULL,
  cancellation_intent INTEGER NOT NULL,
  deadline_trigger INTEGER NOT NULL,
  stdout_available INTEGER CHECK (stdout_available IN (0, 1)),
  stdout_truncated INTEGER NOT NULL,
  stdout_incomplete INTEGER NOT NULL,
  stdout_open_at_cutover INTEGER NOT NULL,
  stderr_available INTEGER CHECK (stderr_available IN (0, 1)),
  stderr_truncated INTEGER NOT NULL,
  stderr_incomplete INTEGER NOT NULL,
  stderr_open_at_cutover INTEGER NOT NULL,
  uncertain INTEGER NOT NULL,
  finalized INTEGER NOT NULL,
  published_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, revision)
);
CREATE TABLE job_notices (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision INTEGER NOT NULL,
  owner_uuid TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1,
  acknowledged_at_ms INTEGER,
  PRIMARY KEY (job_id, revision)
);
CREATE TABLE stale_witnesses (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  observed_claim_id TEXT NOT NULL,
  observed_counter INTEGER NOT NULL,
  observed_revision INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (job_id, observed_claim_id, observed_counter)
);
`;

/** Creates a complete synthetic pre-U2 database and never opens production DDL. */
export function createSchemaV1Fixture(dbPath: string): void {
  const v1Directory = dirname(dbPath);
  const newlyCreatedDirectories: string[] = [];
  let current = v1Directory;
  while (!existsSync(current)) {
    newlyCreatedDirectories.push(current);
    current = dirname(current);
  }
  mkdirSync(v1Directory, { recursive: true, mode: 0o700 });
  for (const directory of newlyCreatedDirectories) chmodSync(directory, 0o700);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_V1_SQL);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '1')",
    ).run();
    db.prepare(
      `INSERT INTO jobs
       (job_id, owner_uuid, owner_session_path, runner_token_hash,
        request_namespace, request_key, command, cwd, deadline_ms,
        accepted_at_ms, deadline_at_ms, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled')`,
    ).run(
      '11111111-2222-4333-8444-555555555555',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '/synthetic/schema-v1-session.jsonl',
      '0'.repeat(64),
      'tool_call',
      'schema-v1',
      'printf schema-v1',
      '/synthetic',
      1000,
      10,
      1010,
    );
    db.prepare(
      `INSERT INTO job_results
       (job_id, revision, launch, cleanup_state, cleanup_kill_intent,
        cancellation_intent, deadline_trigger, stdout_truncated,
        stdout_incomplete, stdout_open_at_cutover, stderr_truncated,
        stderr_incomplete, stderr_open_at_cutover, uncertain, finalized,
        published_at_ms)
       VALUES (?, 1, 'unknown', 'not_requested', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 20)`,
    ).run('11111111-2222-4333-8444-555555555555');
    db.prepare(
      `INSERT INTO job_notices (job_id, revision, owner_uuid, pending)
       VALUES (?, 1, ?, 1)`,
    ).run(
      '11111111-2222-4333-8444-555555555555',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
    db.prepare(
      `INSERT INTO stale_witnesses
       (job_id, observed_claim_id, observed_counter, observed_revision, committed_at_ms)
       VALUES (?, '', 0, 0, 15)`,
    ).run('11111111-2222-4333-8444-555555555555');
  } finally {
    db.close();
  }
  chmodSync(dbPath, 0o600);
}
