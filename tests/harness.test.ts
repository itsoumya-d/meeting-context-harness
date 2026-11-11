import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeNotesWithTranscript,
  assertMeetingAccess,
  PermissionError,
} from '../src/domain.js';
import { createMemoryPostgresStore } from '../src/postgres.js';
import {
  DurableAgentHarness,
  RetryableToolError,
  PermanentToolError,
} from '../src/harness.js';
import { handleIngestionEvent } from '../src/lambdaHandler.js';

test('Postgres expand migrations are idempotent and support time-window transcript lookups', () => {
  const store = createMemoryPostgresStore();
  const firstRun = store.applyMigrations();
  const secondRun = store.applyMigrations();
  assert.deepEqual(firstRun, [1, 2]);
  assert.deepEqual(secondRun, []);

  store.upsertWorkspace('ws-eng', 'Engineering Team');
  store.insertMeeting({
    id: 'mtg-101',
    workspaceId: 'ws-eng',
    folderId: 'fld-roadmap',
    title: 'Q4 Latency Review',
  });
  store.appendChunk({
    id: 'chk-1',
    meetingId: 'mtg-101',
    workspaceId: 'ws-eng',
    speaker: 'Alex',
    startMs: 12_000,
    endMs: 18_500,
    body: 'P95 Postgres read latency jumped after the folder join.',
    confidence: 0.96,
  });
  store.appendChunk({
    id: 'chk-1', // duplicate chunk delivery must safely no-op
    meetingId: 'mtg-101',
    workspaceId: 'ws-eng',
    speaker: 'Alex',
    startMs: 12_000,
    endMs: 18_500,
    body: 'Duplicate overwrite attempt',
    confidence: 0.96,
  });
  store.appendChunk({
    id: 'chk-2',
    meetingId: 'mtg-101',
    workspaceId: 'ws-eng',
    speaker: 'Sam',
    startMs: 180_000,
    endMs: 186_000,
    body: 'Later unrelated agenda topic.',
    confidence: 0.94,
  });

  const rows = store.fetchWindowChunks('ws-eng', 'mtg-101', 0, 40_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.body, 'P95 Postgres read latency jumped after the folder join.');
});

test('Human note anchors merge only nearby transcript evidence with deterministic grounding hashes', () => {
  const merged = mergeNotesWithTranscript(
    [
      {
        anchorId: 'anc-1',
        meetingId: 'mtg-1',
        authorId: 'usr-1',
        offsetMs: 60_000,
        bulletText: 'Need composite index on workspace_id + created_at',
      },
    ],
    [
      {
        segmentId: 'seg-a',
        meetingId: 'mtg-1',
        speaker: 'Jordan',
        startMs: 42_000,
        endMs: 58_000,
        text: 'Query planner shows sequential scan on meetings table.',
        confidence: 0.95,
      },
      {
        segmentId: 'seg-far',
        meetingId: 'mtg-1',
        speaker: 'Jordan',
        startMs: 250_000,
        endMs: 255_000,
        text: 'Unrelated closing remark.',
        confidence: 0.9,
      },
    ],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.supportingSegments.length, 1);
  assert.equal(merged[0]?.supportingSegments[0]?.segmentId, 'seg-a');
  assert.equal(merged[0]?.groundingHash.length, 16);
});

test('Multi-tenant & folder ACL isolation blocks cross-workspace and viewer export attempts', () => {
  assert.throws(
    () =>
      assertMeetingAccess(
        { userId: 'u1', workspaceId: 'ws-other', role: 'owner', folderAclIds: [] },
        'ws-eng',
        null,
        'read',
      ),
    (e: unknown) => e instanceof PermissionError && e.code === 'TENANT_MISMATCH',
  );

  assert.throws(
    () =>
      assertMeetingAccess(
        { userId: 'u2', workspaceId: 'ws-eng', role: 'editor', folderAclIds: ['fld-public'] },
        'ws-eng',
        'fld-exec',
        'read',
      ),
    (e: unknown) => e instanceof PermissionError && e.code === 'FOLDER_ACL_DENIED',
  );

  assert.throws(
    () =>
      assertMeetingAccess(
        { userId: 'u3', workspaceId: 'ws-eng', role: 'viewer', folderAclIds: ['fld-roadmap'] },
        'ws-eng',
        'fld-roadmap',
        'export',
      ),
    (e: unknown) => e instanceof PermissionError && e.code === 'READ_ONLY_ROLE',
  );
});

test('Durable agent harness retries transient faults, caches idempotent replays, and dead-letters permanent errors', async () => {
  const harness = new DurableAgentHarness(3);
  let calls = 0;
  harness.registerTool('crm.sync_action_items', async (req) => {
    calls += 1;
    if (calls < 2) throw new RetryableToolError('Upstream CRM 429 rate limit');
    return { synced: true, attempt: req.attempt };
  });
  harness.registerTool('workspace.search_notes', async () => {
    throw new PermanentToolError('Malformed workspace filter');
  });

  const actor = { userId: 'u1', workspaceId: 'ws-eng', role: 'editor' as const, folderAclIds: ['fld-sales'] };

  const first = await harness.dispatch(
    {
      idempotencyKey: 'sync-key-0001',
      meetingId: 'mtg-1',
      workspaceId: 'ws-eng',
      toolName: 'crm.sync_action_items',
      payload: { dealId: 'd-9' },
    },
    actor,
    'fld-sales',
  );
  assert.equal(first.status, 'succeeded');
  assert.equal(first.attemptsUsed, 2);
  assert.equal(first.replayedFromCache, false);

  const replay = await harness.dispatch(
    {
      idempotencyKey: 'sync-key-0001',
      meetingId: 'mtg-1',
      workspaceId: 'ws-eng',
      toolName: 'crm.sync_action_items',
      payload: { dealId: 'd-9' },
    },
    actor,
    'fld-sales',
  );
  assert.equal(replay.replayedFromCache, true);
  assert.equal(calls, 2); // Must NOT invoke downstream tool twice

  const dlq = await harness.dispatch(
    {
      idempotencyKey: 'bad-key-0002',
      meetingId: 'mtg-1',
      workspaceId: 'ws-eng',
      toolName: 'workspace.search_notes',
      payload: {},
    },
    actor,
    'fld-sales',
  );
  assert.equal(dlq.status, 'dead_letter');
  assert.equal(dlq.attemptsUsed, 1);
});

test('AWS Lambda ingestion handler enforces tenant boundaries, persists chunks, and invokes harness', async () => {
  const store = createMemoryPostgresStore();
  store.applyMigrations();

  const harness = new DurableAgentHarness(2);
  harness.registerTool('meeting.fetch_transcript_window', async (req) => ({
    window: store.fetchWindowChunks(req.workspaceId, req.meetingId, 0, 50_000),
  }));

  const denied = await handleIngestionEvent(
    {
      requestId: 'req-1',
      actor: { userId: 'u1', workspaceId: 'ws-evil', role: 'owner', folderAclIds: [] },
      meeting: { id: 'm1', workspaceId: 'ws-good', folderId: null, title: 'Sync' },
      chunks: [],
    },
    store,
    harness,
  );
  assert.equal(denied.statusCode, 403);

  const ok = await handleIngestionEvent(
    {
      requestId: 'req-2',
      actor: { userId: 'u2', workspaceId: 'ws-good', role: 'owner', folderAclIds: [] },
      meeting: { id: 'm1', workspaceId: 'ws-good', folderId: null, title: 'Sync' },
      chunks: [
        {
          id: 'c1',
          speaker: 'Host',
          startMs: 1_000,
          endMs: 9_000,
          body: 'Ship Terraform Lambda + SQS dead letter policies today.',
          confidence: 0.98,
        },
      ],
      followUpToolCall: {
        idempotencyKey: 'req-2-tool-window',
        toolName: 'meeting.fetch_transcript_window',
        payload: {},
      },
    },
    store,
    harness,
  );
  assert.equal(ok.statusCode, 200);
  const parsed = JSON.parse(ok.body);
  assert.equal(parsed.chunksIngested, 1);
  assert.equal(parsed.harnessOutcome.status, 'succeeded');
  assert.equal(parsed.harnessOutcome.result.window.length, 1);
});
