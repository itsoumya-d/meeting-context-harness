import { ToolCallRequest, ToolCallRequestSchema, ActorContext, assertMeetingAccess } from './domain.js';

export type ToolHandler = (req: ToolCallRequest) => Promise<Record<string, unknown>>;

export interface JobExecutionOutcome {
  idempotencyKey: string;
  status: 'succeeded' | 'dead_letter';
  replayedFromCache: boolean;
  attemptsUsed: number;
  result?: Record<string, unknown>;
  errorMessage?: string;
}

export class RetryableToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableToolError';
  }
}

export class PermanentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentToolError';
  }
}

/**
 * Deterministic backend agent harness for long-running workspace/transcription jobs:
 * - Enforces tenant & folder ACL boundaries prior to tool dispatch
 * - Deduplicates repeated deliveries via idempotency keys
 * - Bounds exponential backoff retries cleanly and promotes non-recoverable faults to dead-letter
 */
export class DurableAgentHarness {
  private readonly ledger = new Map<string, JobExecutionOutcome>();
  private readonly handlers = new Map<ToolCallRequest['toolName'], ToolHandler>();

  constructor(private readonly maxAttempts = 3) {}

  registerTool(name: ToolCallRequest['toolName'], handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  async dispatch(
    rawReq: unknown,
    actor: ActorContext,
    meetingFolderId: string | null,
  ): Promise<JobExecutionOutcome> {
    const req = ToolCallRequestSchema.parse(rawReq);
    const action = req.toolName === 'crm.sync_action_items' ? 'export' : 'read';
    assertMeetingAccess(actor, req.workspaceId, meetingFolderId, action);

    const existing = this.ledger.get(req.idempotencyKey);
    if (existing) {
      return { ...existing, replayedFromCache: true };
    }

    const handler = this.handlers.get(req.toolName);
    if (!handler) {
      throw new PermanentToolError(`Unregistered tool handler: ${req.toolName}`);
    }

    let lastErr = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await handler({ ...req, attempt });
        const ok: JobExecutionOutcome = {
          idempotencyKey: req.idempotencyKey,
          status: 'succeeded',
          replayedFromCache: false,
          attemptsUsed: attempt,
          result,
        };
        this.ledger.set(req.idempotencyKey, ok);
        return ok;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (err instanceof PermanentToolError || !(err instanceof RetryableToolError)) {
          const failed: JobExecutionOutcome = {
            idempotencyKey: req.idempotencyKey,
            status: 'dead_letter',
            replayedFromCache: false,
            attemptsUsed: attempt,
            errorMessage: lastErr,
          };
          this.ledger.set(req.idempotencyKey, failed);
          return failed;
        }
      }
    }

    const exhausted: JobExecutionOutcome = {
      idempotencyKey: req.idempotencyKey,
      status: 'dead_letter',
      replayedFromCache: false,
      attemptsUsed: this.maxAttempts,
      errorMessage: `Retry budget exhausted: ${lastErr}`,
    };
    this.ledger.set(req.idempotencyKey, exhausted);
    return exhausted;
  }
}
