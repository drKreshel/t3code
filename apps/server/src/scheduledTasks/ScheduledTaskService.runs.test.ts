import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const insertThread = (threadId: string, title: string, deletedAt: string | null = null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at,
        payload_json)
      VALUES (${threadId}, 'project-1', ${title}, 'codex', 'full-access', 'default',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${deletedAt}, '{}')
    `,
  );

const insertUserMessage = (input: {
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly scheduledTaskId?: string;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming,
        created_at, updated_at, payload_json)
      VALUES (${input.messageId}, ${input.threadId}, 'user', 0, ${input.createdAt},
        ${input.createdAt},
        ${JSON.stringify(input.scheduledTaskId ? { scheduledTaskId: input.scheduledTaskId } : {})})
    `,
  );

const insertRun = (input: {
  readonly runId: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly userMessageId: string;
  readonly status: string;
  readonly completedAt: string | null;
  readonly model?: string;
}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status,
        requested_at, completed_at, payload_json)
      VALUES (${input.runId}, ${input.threadId}, ${input.ordinal}, 'codex', ${input.status},
        '2026-10-01T00:00:00.000Z', ${input.completedAt},
        ${JSON.stringify({
          userMessageId: input.userMessageId,
          ...(input.model
            ? {
                modelSelection: {
                  instanceId: "codex",
                  model: input.model,
                  options: [{ id: "reasoningEffort", value: "high" }],
                },
              }
            : {}),
        })})
    `,
  );

it.effect("lists task runs newest first with their turn's outcome, skipping deleted chats", () =>
  Effect.gen(function* () {
    yield* insertThread("chat-a", "Blog draft, Oct 1");
    yield* insertThread("chat-b", "Blog draft, Oct 2");
    yield* insertThread("bound", "SERP checks");
    yield* insertThread("gone", "Deleted run", "2026-10-03T00:00:00.000Z");
    yield* insertUserMessage({
      messageId: "m-a",
      threadId: "chat-a",
      createdAt: "2026-10-01T06:00:00.000Z",
      scheduledTaskId: "blog",
    });
    yield* insertRun({
      runId: "r-a",
      threadId: "chat-a",
      ordinal: 1,
      userMessageId: "m-a",
      status: "completed",
      completedAt: "2026-10-01T06:20:00.000Z",
      model: "gpt-5.6-sol",
    });
    yield* insertUserMessage({
      messageId: "m-b",
      threadId: "chat-b",
      createdAt: "2026-10-02T06:00:00.000Z",
      scheduledTaskId: "blog",
    });
    yield* insertRun({
      runId: "r-b",
      threadId: "chat-b",
      ordinal: 1,
      userMessageId: "m-b",
      status: "failed",
      completedAt: "2026-10-02T06:01:00.000Z",
    });
    // A bound chat: one run in progress, one prompt still waiting its turn, one typed by a person.
    yield* insertUserMessage({
      messageId: "m-s1",
      threadId: "bound",
      createdAt: "2026-10-02T09:15:00.000Z",
      scheduledTaskId: "serp",
    });
    yield* insertRun({
      runId: "r-s1",
      threadId: "bound",
      ordinal: 1,
      userMessageId: "m-s1",
      status: "running",
      completedAt: null,
    });
    yield* insertUserMessage({
      messageId: "m-s2",
      threadId: "bound",
      createdAt: "2026-10-02T09:45:00.000Z",
      scheduledTaskId: "serp",
    });
    yield* insertUserMessage({
      messageId: "m-person",
      threadId: "bound",
      createdAt: "2026-10-02T10:00:00.000Z",
    });
    yield* insertUserMessage({
      messageId: "m-gone",
      threadId: "gone",
      createdAt: "2026-10-03T06:00:00.000Z",
      scheduledTaskId: "blog",
    });

    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const all = yield* service.listRuns({});
      expect(all.runs.map((run) => [run.messageId, run.state])).toEqual([
        ["m-s2", "queued"],
        ["m-s1", "running"],
        ["m-b", "failed"],
        ["m-a", "succeeded"],
      ]);
      expect(all.runs.at(-1)).toMatchObject({
        taskId: "blog",
        threadId: "chat-a",
        threadTitle: "Blog draft, Oct 1",
        startedAt: "2026-10-01T06:00:00.000Z",
        finishedAt: "2026-10-01T06:20:00.000Z",
        // What the turn ran with, not whatever the task says today.
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      // A prompt still waiting for its turn has no model yet.
      expect(all.runs[0]?.modelSelection).toBeNull();
      const blog = yield* service.listRuns({ id: ScheduledTaskId.make("blog"), limit: 1 });
      expect(blog.runs.map((run) => run.messageId)).toEqual(["m-b"]);
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeCrypto.layer,
              Scheduler.layer,
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
