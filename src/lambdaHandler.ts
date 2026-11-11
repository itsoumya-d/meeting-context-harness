import { z } from 'zod';
import { PostgresStore } from './postgres.js';
import { DurableAgentHarness } from './harness.js';
import { ActorContextSchema } from './domain.js';

export const LambdaIngestionEventSchema = z.object({
  requestId: z.string().min(1),
  actor: ActorContextSchema,
  meeting: z.object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    folderId: z.string().nullable(),
    title: z.string().min(1),
  }),
  chunks: z.array(
    z.object({
      id: z.string().min(1),
      speaker: z.string().min(1),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      body: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
  followUpToolCall: z
    .object({
      idempotencyKey: z.string().min(8),
      toolName: z.enum([
        'workspace.search_notes',
        'meeting.fetch_transcript_window',
        'crm.sync_action_items',
      ]),
      payload: z.record(z.unknown()),
    })
    .optional(),
});

export interface LambdaResponse {
  statusCode: number;
  body: string;
}

/**
 * AWS Lambda-compatible streaming transcript + workspace agent trigger handler.
 * Validates schema boundaries, appends idempotent transcript segments into Postgres,
 * and dispatches follow-up harness actions under strict tenant ACL enforcement.
 */
export async function handleIngestionEvent(
  rawEvent: unknown,
  store: PostgresStore,
  harness: DurableAgentHarness,
): Promise<LambdaResponse> {
  const parsed = LambdaIngestionEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'INVALID_PAYLOAD', issues: parsed.error.issues }),
    };
  }

  const ev = parsed.data;
  if (ev.actor.workspaceId !== ev.meeting.workspaceId) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'TENANT_ISOLATION_VIOLATION' }),
    };
  }

  store.upsertWorkspace(ev.meeting.workspaceId, `ws-${ev.meeting.workspaceId}`);
  try {
    store.insertMeeting({
      id: ev.meeting.id,
      workspaceId: ev.meeting.workspaceId,
      folderId: ev.meeting.folderId,
      title: ev.meeting.title,
    });
  } catch {
    // Meeting already initialized across prior Lambda streaming chunk; continue chunk appends.
  }

  for (const ch of ev.chunks) {
    store.appendChunk({
      id: ch.id,
      meetingId: ev.meeting.id,
      workspaceId: ev.meeting.workspaceId,
      speaker: ch.speaker,
      startMs: ch.startMs,
      endMs: ch.endMs,
      body: ch.body,
      confidence: ch.confidence,
    });
  }

  let harnessOutcome = null;
  if (ev.followUpToolCall) {
    harnessOutcome = await harness.dispatch(
      {
        idempotencyKey: ev.followUpToolCall.idempotencyKey,
        meetingId: ev.meeting.id,
        workspaceId: ev.meeting.workspaceId,
        toolName: ev.followUpToolCall.toolName,
        payload: ev.followUpToolCall.payload,
      },
      ev.actor,
      ev.meeting.folderId,
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      requestId: ev.requestId,
      chunksIngested: ev.chunks.length,
      harnessOutcome,
    }),
  };
}
