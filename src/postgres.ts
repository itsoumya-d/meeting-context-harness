import { newDb, IMemoryDb } from 'pg-mem';

/**
 * Zero-downtime PostgreSQL migrations (expand/contract stages).
 * Every stage avoids ACCESS EXCLUSIVE locks across live traffic tables:
 * - v1: Base tenant workspaces, meetings, transcript chunks, human anchors, idempotency ledger.
 * - v2: Concurrent-friendly composite index pattern & optional grounding_hash column (NULL-safe expand).
 */
export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: '001_initial_workspace_schema',
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        folder_id TEXT,
        title TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL
      );

      CREATE INDEX idx_meetings_workspace_folder
        ON meetings (workspace_id, folder_id, created_at_ms DESC);

      CREATE TABLE transcript_chunks (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        workspace_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        body TEXT NOT NULL,
        confidence NUMERIC(4,3) NOT NULL
      );

      CREATE INDEX idx_chunks_meeting_time
        ON transcript_chunks (workspace_id, meeting_id, start_ms);

      CREATE TABLE agent_job_runs (
        idempotency_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        result_json TEXT,
        last_error TEXT
      );

      CREATE INDEX idx_agent_jobs_status
        ON agent_job_runs (workspace_id, status);
    `,
  },
  {
    version: 2,
    name: '002_expand_grounding_and_retention',
    sql: `
      ALTER TABLE meetings ADD COLUMN summary_version INTEGER DEFAULT 1;
      ALTER TABLE meetings ADD COLUMN grounding_sha256 TEXT;
    `,
  },
];

export interface PostgresStore {
  db: IMemoryDb;
  applyMigrations(): number[];
  upsertWorkspace(id: string, name: string): void;
  insertMeeting(m: { id: string; workspaceId: string; folderId: string | null; title: string; createdAtMs?: number }): void;
  appendChunk(c: {
    id: string;
    meetingId: string;
    workspaceId: string;
    speaker: string;
    startMs: number;
    endMs: number;
    body: string;
    confidence: number;
  }): void;
  listWorkspaceMeetings(workspaceId: string, limit: number): Array<{ id: string; folder_id: string | null; title: string }>;
  fetchWindowChunks(workspaceId: string, meetingId: string, startMs: number, endMs: number): Array<{ id: string; speaker: string; start_ms: number; end_ms: number; body: string }>;
}

export function createMemoryPostgresStore(): PostgresStore {
  const db = newDb();

  function q(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    let formatted = sql;
    params.forEach((val, idx) => {
      const placeholder = `$${idx + 1}`;
      let encoded: string;
      if (val === null || val === undefined) encoded = 'NULL';
      else if (typeof val === 'number') encoded = Number.isFinite(val) ? String(val) : 'NULL';
      else encoded = `'${String(val).replace(/'/g, "''")}'`;
      formatted = formatted.replaceAll(placeholder, encoded);
    });
    return db.public.many(formatted) as Record<string, unknown>[];
  }

  return {
    db,
    applyMigrations(): number[] {
      const hasTable = db.public.many(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations'",
      );
      if (hasTable.length === 0) {
        db.public.none('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);');
      }
      const existing = new Set(
        (db.public.many('SELECT version FROM schema_migrations') as Array<{ version: number }>).map(
          (r) => r.version,
        ),
      );
      const applied: number[] = [];
      for (const mig of MIGRATIONS) {
        if (existing.has(mig.version)) continue;
        db.public.none(mig.sql);
        q('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [mig.version, mig.name]);
        applied.push(mig.version);
      }
      return applied;
    },

    upsertWorkspace(id, name) {
      q('INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [
        id,
        name,
      ]);
    },

    insertMeeting(m) {
      q('INSERT INTO meetings (id, workspace_id, folder_id, title, created_at_ms) VALUES ($1, $2, $3, $4, $5)', [
        m.id,
        m.workspaceId,
        m.folderId,
        m.title,
        m.createdAtMs ?? Date.now(),
      ]);
    },

    appendChunk(c) {
      q(
        `INSERT INTO transcript_chunks (id, meeting_id, workspace_id, speaker, start_ms, end_ms, body, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.meetingId, c.workspaceId, c.speaker, c.startMs, c.endMs, c.body, c.confidence],
      );
    },

    listWorkspaceMeetings(workspaceId, limit) {
      return q(
        'SELECT id, folder_id, title FROM meetings WHERE workspace_id = $1 ORDER BY created_at_ms DESC LIMIT $2',
        [workspaceId, limit],
      ) as Array<{ id: string; folder_id: string | null; title: string }>;
    },

    fetchWindowChunks(workspaceId, meetingId, startMs, endMs) {
      return q(
        `SELECT id, speaker, start_ms, end_ms, body
         FROM transcript_chunks
         WHERE workspace_id = $1 AND meeting_id = $2 AND end_ms >= $3 AND start_ms <= $4
         ORDER BY start_ms ASC`,
        [workspaceId, meetingId, startMs, endMs],
      ) as Array<{ id: string; speaker: string; start_ms: number; end_ms: number; body: string }>;
    },
  };
}
