import { AutomationAction, AutomationTrigger, TicketWorkflow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEFAULT_WORKFLOWS, instructionsFromAutomation } from "./workflowLogic.ts";

const encodeTrigger = Schema.encodeSync(Schema.fromJsonString(AutomationTrigger));
const encodeAction = Schema.encodeSync(Schema.fromJsonString(AutomationAction));
const encodeWorkflow = Schema.encodeSync(Schema.fromJsonString(TicketWorkflow));
const encodePayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeTrigger = Schema.decodeUnknownSync(Schema.fromJsonString(AutomationTrigger));
const decodeAction = Schema.decodeUnknownSync(Schema.fromJsonString(AutomationAction));

/** Preserve hook prompts and run history, then stop reacting to column moves. */
export const migrateColumnWorkflows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  const boards = yield* sql<{ id: string; name: string }>`SELECT id, name FROM fork_boards`;
  const hooks = yield* sql<{
    id: string;
    title: string;
    prompt: string;
    trigger_json: string;
    action_json: string;
    enabled: number;
  }>`SELECT a.* FROM fork_automations a LEFT JOIN fork_board_columns c
      ON c.id = json_extract(a.trigger_json, '$.columnId')
      WHERE json_extract(a.trigger_json, '$.type') = 'board'
      ORDER BY c.position, a.created_at, a.id`;
  const groups = new Map<string | null, TicketWorkflow[]>();
  for (const hook of hooks) {
    const trigger = decodeTrigger(hook.trigger_json);
    if (trigger.type !== "board") continue;
    const originalAction = decodeAction(hook.action_json);
    const { steps: _steps, ...chatAction } = originalAction;
    const action = {
      ...chatAction,
      checkout: chatAction.checkout === "worktree" ? ("ticket" as const) : chatAction.checkout,
    };
    const prompt = instructionsFromAutomation(hook.prompt, originalAction);
    const boardName = boards.find((board) => board.id === trigger.boardId)?.name;
    const title = boardName ? `${boardName} · ${hook.title}` : hook.title;
    yield* sql`UPDATE fork_automations SET trigger_json = ${encodeTrigger({ type: "workflow" })},
      title = ${title}, prompt = ${prompt}, action_json = ${encodeAction(action)}, updated_at = ${at}
      WHERE id = ${hook.id}`;
    if (hook.enabled && prompt.trim()) {
      const group = groups.get(trigger.boardId) ?? [];
      group.push({ presetId: hook.id, title: hook.title, prompt, action });
      groups.set(trigger.boardId, group);
    }
  }
  const insertPreset = (workflow: TicketWorkflow) => sql`
    INSERT INTO fork_automations (id, title, prompt, trigger_json, action_json, enabled,
      max_runs_per_ticket, created_at, updated_at)
    VALUES (${workflow.presetId}, ${workflow.title}, ${workflow.prompt},
      ${encodeTrigger({ type: "workflow" })}, ${encodeAction(workflow.action)}, 1, 5, ${at}, ${at})
    ON CONFLICT(id) DO NOTHING
  `;
  for (const workflow of DEFAULT_WORKFLOWS) yield* insertPreset(workflow);
  for (const [boardId, stages] of groups) {
    const first = stages[0];
    if (!first) continue;
    const name = boards.find((board) => board.id === boardId)?.name ?? "Shared";
    const workflow: TicketWorkflow = {
      presetId: `migrated:workflow:${boardId ?? "all"}`,
      title: `${name} workflow`,
      action: first.action,
      prompt: [
        "Follow the stages below in order, starting from the current column and latest handoff. Column changes record progress; continue in this session or delegate as instructed. Keep the ticket's handoff current. At Ready, call request_human for user validation before continuing delivery. On Resume, continue from the latest handoff. Respect the user's authorization for pushing, merging, and publishing.",
        ...stages.map(
          (stage) =>
            `## ${stage.title}\n\n${stage.action.modelSelection ? `Use provider ${stage.action.modelSelection.instanceId} and model ${stage.action.modelSelection.model} for this stage. Delegate when it differs from the workflow session.\n\n` : ""}${stage.prompt}`,
        ),
      ].join("\n\n"),
    };
    yield* insertPreset(workflow);
    yield* sql`UPDATE fork_tickets SET workflow_json = ${encodeWorkflow(workflow)},
        workflow_thread_key = (SELECT r.thread_key FROM fork_automation_runs r
          WHERE r.ticket_id = fork_tickets.id AND r.thread_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fork_ticket_threads links
            WHERE links.thread_key = r.thread_key AND links.ticket_id <> fork_tickets.id)
          ORDER BY CASE WHEN r.status = 'running' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 1)
        WHERE (${boardId} IS NOT NULL AND board_id = ${boardId} OR ${boardId} IS NULL AND workflow_json IS NULL) AND archived_at IS NULL`;
    yield* sql`INSERT INTO fork_ticket_events (id, ticket_id, kind, payload_json, actor, created_at)
        SELECT ${`workflow-migration:${workflow.presetId}:`} || id, id, 'updated',
          ${encodePayload({ fields: ["workflow"], workflow: workflow.title })}, 'system', ${at}
        FROM fork_tickets WHERE json_extract(workflow_json, '$.presetId') = ${workflow.presetId} AND archived_at IS NULL`;
    yield* sql`INSERT INTO fork_ticket_threads (thread_key, ticket_id, source, linked_at)
        SELECT workflow_thread_key, id, 'workflow-migration', ${at} FROM fork_tickets
        WHERE json_extract(workflow_json, '$.presetId') = ${workflow.presetId} AND workflow_thread_key IS NOT NULL
        ON CONFLICT(thread_key) DO NOTHING`;
  }
  yield* sql`UPDATE fork_automation_runs SET status = 'skipped',
    reason = 'Column hooks were migrated to explicitly started ticket workflows.', finished_at = ${at}
    WHERE status = 'queued' AND automation_id IN
      (SELECT id FROM fork_automations WHERE json_extract(trigger_json, '$.type') = 'workflow')`;
});
