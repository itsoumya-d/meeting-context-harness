import crypto from 'node:crypto';
import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ActorContextSchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  role: WorkspaceRoleSchema,
  folderAclIds: z.array(z.string()).default([]),
});
export type ActorContext = z.infer<typeof ActorContextSchema>;

export const TranscriptSegmentSchema = z.object({
  segmentId: z.string().min(1),
  meetingId: z.string().min(1),
  speaker: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const HumanNoteAnchorSchema = z.object({
  anchorId: z.string().min(1),
  meetingId: z.string().min(1),
  authorId: z.string().min(1),
  offsetMs: z.number().int().nonnegative(),
  bulletText: z.string().min(1),
});
export type HumanNoteAnchor = z.infer<typeof HumanNoteAnchorSchema>;

export const ToolCallRequestSchema = z.object({
  idempotencyKey: z.string().min(8),
  meetingId: z.string().min(1),
  workspaceId: z.string().min(1),
  toolName: z.enum([
    'workspace.search_notes',
    'meeting.fetch_transcript_window',
    'crm.sync_action_items',
  ]),
  payload: z.record(z.unknown()),
  attempt: z.number().int().nonnegative().default(0),
});
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;

export interface MergedNoteSection {
  humanBullet: string;
  offsetMs: number;
  supportingSegments: TranscriptSegment[];
  groundingHash: string;
}

/**
 * Merges sparse human bullets (ground truth) with overlapping real-time transcript
 * segments inside a configurable lookback/lookahead window, preserving audit hashes
 * without overwriting the human's framing.
 */
export function mergeNotesWithTranscript(
  anchors: HumanNoteAnchor[],
  segments: TranscriptSegment[],
  windowBeforeMs = 45_000,
  windowAfterMs = 20_000,
): MergedNoteSection[] {
  const orderedAnchors = [...anchors].sort((a, b) => a.offsetMs - b.offsetMs);
  const orderedSegments = [...segments].sort((a, b) => a.startMs - b.startMs);

  return orderedAnchors.map((anchor) => {
    const startBound = Math.max(0, anchor.offsetMs - windowBeforeMs);
    const endBound = anchor.offsetMs + windowAfterMs;
    const supporting = orderedSegments.filter(
      (s) =>
        s.meetingId === anchor.meetingId &&
        s.endMs >= startBound &&
        s.startMs <= endBound,
    );

    const hashInput = JSON.stringify({
      anchorId: anchor.anchorId,
      bullet: anchor.bulletText,
      segmentIds: supporting.map((s) => s.segmentId),
    });

    return {
      humanBullet: anchor.bulletText,
      offsetMs: anchor.offsetMs,
      supportingSegments: supporting,
      groundingHash: crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16),
    };
  });
}

/**
 * Enforces strict multi-tenant workspace and folder visibility before either a
 * user query or an MCP/agent tool invocation reads meeting data.
 */
export function assertMeetingAccess(
  actor: ActorContext,
  meetingWorkspaceId: string,
  folderId: string | null,
  action: 'read' | 'write' | 'export',
): void {
  if (actor.workspaceId !== meetingWorkspaceId) {
    throw new PermissionError('TENANT_MISMATCH', 'Cross-workspace access denied');
  }
  if (folderId && actor.role !== 'owner' && !actor.folderAclIds.includes(folderId)) {
    throw new PermissionError('FOLDER_ACL_DENIED', `Actor lacks folder ACL ${folderId}`);
  }
  if ((action === 'write' || action === 'export') && actor.role === 'viewer') {
    throw new PermissionError('READ_ONLY_ROLE', 'Viewer role cannot mutate or export');
  }
}

export class PermissionError extends Error {
  constructor(
    public readonly code: 'TENANT_MISMATCH' | 'FOLDER_ACL_DENIED' | 'READ_ONLY_ROLE',
    message: string,
  ) {
    super(message);
    this.name = 'PermissionError';
  }
}
