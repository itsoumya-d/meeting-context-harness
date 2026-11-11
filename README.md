# meeting-context-harness

Reference TypeScript, PostgreSQL, AWS Lambda/Terraform, and durable agent harness implementation for multi-tenant meeting context workspaces.

## Problem Solved
Meeting-note and conversational context platforms fail in production along three predictable fault lines:
1. **Unbounded agent retries & duplicate side effects** when external CRM/webhook tools flake mid-run.
2. **Tenant & folder ACL leaks** across shared team workspaces and automated tool calls.
3. **Slow Postgres queries & table-locking migrations** on growing transcript chunk tables.

## Architecture & Scope
- `src/domain.ts`: Multi-tenant workspace + folder ACL enforcement (`assertMeetingAccess`) and sparse-human-bullet to transcript window grounding (`mergeNotesWithTranscript`) with SHA-256 provenance hashes.
- `src/postgres.ts`: Expand/contract zero-downtime SQL migrations and composite-indexed workspace/time-window chunk queries verified against `pg-mem` Postgres dialect.
- `src/harness.ts`: Idempotent tool execution harness with retry budgets (`RetryableToolError`), deterministic replay cache, and automatic dead-letter promotion.
- `src/lambdaHandler.ts`: Typed AWS Lambda ingestion handler (`zod`) connecting real-time transcript streaming to Postgres + follow-up agent dispatch.
- `infra/main.tf`: AWS KMS key rotation, encrypted S3 transcript archive, SQS + DLQ redrive policy, and Node.js 22 Lambda IAM/deployment Terraform configuration (validated in CI via `terraform validate`).

## Honest Scope & Non-Goals
- Uses `pg-mem` (in-memory PostgreSQL engine) and mock tool transport in automated CI tests so every test runs hermetically without cloud credentials.
- Does not claim production deployment traffic or customer usage.

## Run Locally
```bash
npm install
npm run build
npm test
```
