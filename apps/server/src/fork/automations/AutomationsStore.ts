/**
 * Storage for scheduled automations, workflow presets, and their runs in `fork.sqlite`. Every
 * write publishes a change; subscribers reload the whole snapshot, which stays
 * small (automations plus the most recent runs).
 */
import {
  type Automation,
  AutomationAction,
  type AutomationRun,
  type AutomationRunStatus,
  AutomationsCommandError,
  type AutomationsSnapshot,
  AutomationTrigger,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ForkDatabase from "../ForkDatabase.ts";
import { nextScheduledAt } from "./automationLogic.ts";

const TriggerJson = Schema.fromJsonString(AutomationTrigger);
const ActionJson = Schema.fromJsonString(AutomationAction);
const decodeTrigger = Schema.decodeUnknownSync(TriggerJson);
const decodeAction = Schema.decodeUnknownSync(ActionJson);
const encodeTrigger = Schema.encodeSync(TriggerJson);
const encodeAction = Schema.encodeSync(ActionJson);

/** Runs kept in the snapshot; older ones stay in the table for counting. */
const SNAPSHOT_RUN_LIMIT = 300;

/** An automation plus when it last fired, which the scheduler needs. */
export interface StoredAutomation extends Automation {
  readonly lastFiredAt: string | null;
}

export interface NewAutomation {
  readonly title: string;
  readonly prompt: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly enabled: boolean;
  readonly maxRunsPerTicket: number;
}

export interface RunPatch {
  readonly status?: AutomationRunStatus;
  readonly reason?: string | null;
  readonly threadKey?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

type StoreError = AutomationsCommandError;

export class AutomationsStore extends Context.Service<
  AutomationsStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<StoredAutomation>, StoreError>;
    readonly get: (id: string) => Effect.Effect<StoredAutomation, StoreError>;
    readonly create: (input: NewAutomation) => Effect.Effect<string, StoreError>;
    readonly update: (id: string, patch: Partial<NewAutomation>) => Effect.Effect<void, StoreError>;
    readonly remove: (id: string) => Effect.Effect<void, StoreError>;
    readonly markFired: (id: string, at: string) => Effect.Effect<void, StoreError>;
    readonly insertRun: (run: {
      readonly automationId: string;
      readonly ticketId: string | null;
      readonly status: AutomationRunStatus;
      readonly reason?: string | null;
    }) => Effect.Effect<string, StoreError>;
    readonly updateRun: (id: string, patch: RunPatch) => Effect.Effect<void, StoreError>;
    readonly runsWithStatus: (
      status: AutomationRunStatus,
    ) => Effect.Effect<ReadonlyArray<AutomationRun>, StoreError>;
    readonly runsForTicket: (
      ticketId: string,
    ) => Effect.Effect<ReadonlyArray<AutomationRun>, StoreError>;
    readonly runningRunForThread: (
      threadKey: string,
    ) => Effect.Effect<Option.Option<AutomationRun>, StoreError>;
    readonly snapshot: Effect.Effect<AutomationsSnapshot, StoreError>;
    readonly stream: Stream.Stream<AutomationsSnapshot, StoreError>;
  }
>()("t3/fork/automations/AutomationsStore") {}

interface AutomationRow {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly trigger_json: string;
  readonly action_json: string;
  readonly enabled: number;
  readonly max_runs_per_ticket: number;
  readonly last_fired_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunRow {
  readonly id: string;
  readonly automation_id: string;
  readonly ticket_id: string | null;
  readonly thread_key: string | null;
  readonly status: AutomationRunStatus;
  readonly reason: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

const toAutomation = (row: AutomationRow): StoredAutomation => {
  const trigger = decodeTrigger(row.trigger_json);
  const enabled = row.enabled === 1;
  const next = enabled
    ? nextScheduledAt(
        trigger,
        DateTime.makeUnsafe(row.last_fired_at ?? row.created_at),
        row.last_fired_at !== null,
      )
    : null;
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    trigger,
    action: decodeAction(row.action_json),
    enabled,
    maxRunsPerTicket: row.max_runs_per_ticket,
    nextRunAt: next ? DateTime.formatIso(next) : null,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const toRun = (row: RunRow): AutomationRun => ({
  id: row.id,
  automationId: row.automation_id,
  ticketId: row.ticket_id,
  threadKey: row.thread_key,
  status: row.status,
  reason: row.reason,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<void>();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new AutomationsCommandError({
            code: "storage",
            message: cause instanceof Error ? cause.message : "Automations storage failed.",
          }),
      ),
    );
  /** A write: stored, then announced. */
  const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    storage(effect).pipe(Effect.tap(() => PubSub.publish(changes, undefined)));

  const list = storage(
    sql<AutomationRow>`SELECT * FROM fork_automations ORDER BY created_at`.pipe(
      Effect.map((rows) => rows.map(toAutomation)),
    ),
  );

  const get = (id: string) =>
    storage(sql<AutomationRow>`SELECT * FROM fork_automations WHERE id = ${id}`).pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? Effect.succeed(toAutomation(rows[0]))
          : Effect.fail(
              new AutomationsCommandError({
                code: "not-found",
                message: "That automation no longer exists.",
              }),
            ),
      ),
    );

  const create = (input: NewAutomation) =>
    write(
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4;
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO fork_automations (id, title, prompt, trigger_json, action_json, enabled,
            max_runs_per_ticket, created_at, updated_at)
          VALUES (${id}, ${input.title}, ${input.prompt}, ${encodeTrigger(input.trigger)},
            ${encodeAction(input.action)}, ${input.enabled ? 1 : 0}, ${input.maxRunsPerTicket},
            ${at}, ${at})
        `;
        return id;
      }),
    );

  const update = (id: string, patch: Partial<NewAutomation>) =>
    Effect.gen(function* () {
      const current = yield* get(id);
      const at = yield* nowIso;
      const trigger = patch.trigger ?? current.trigger;
      // A changed schedule starts counting from now, so it does not fire for
      // occurrences between its last firing and the edit.
      const rescheduled =
        patch.trigger !== undefined || (patch.enabled === true && !current.enabled);
      // A one-off moved to another time may fire again, even if it already did.
      const movedOnce =
        trigger.type === "schedule" &&
        trigger.schedule.kind === "once" &&
        !(
          current.trigger.type === "schedule" &&
          current.trigger.schedule.kind === "once" &&
          current.trigger.schedule.at === trigger.schedule.at
        );
      yield* write(sql`
        UPDATE fork_automations SET
          title = ${patch.title ?? current.title},
          prompt = ${patch.prompt ?? current.prompt},
          trigger_json = ${encodeTrigger(trigger)},
          action_json = ${encodeAction(patch.action ?? current.action)},
          enabled = ${(patch.enabled ?? current.enabled) ? 1 : 0},
          max_runs_per_ticket = ${patch.maxRunsPerTicket ?? current.maxRunsPerTicket},
          last_fired_at = ${
            movedOnce
              ? null
              : rescheduled && trigger.type === "schedule" && trigger.schedule.kind === "cron"
                ? at
                : current.lastFiredAt
          },
          updated_at = ${at}
        WHERE id = ${id}
      `);
    });

  const remove = (id: string) => write(sql`DELETE FROM fork_automations WHERE id = ${id}`);

  const markFired = (id: string, at: string) =>
    write(sql`UPDATE fork_automations SET last_fired_at = ${at} WHERE id = ${id}`);

  const insertRun: AutomationsStore["Service"]["insertRun"] = (run) =>
    write(
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4;
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO fork_automation_runs (id, automation_id, ticket_id, status, reason, created_at)
          VALUES (${id}, ${run.automationId}, ${run.ticketId}, ${run.status},
            ${run.reason ?? null}, ${at})
        `;
        return id;
      }),
    );

  const updateRun = (id: string, patch: RunPatch) =>
    Effect.gen(function* () {
      const rows = yield* storage(sql<RunRow>`SELECT * FROM fork_automation_runs WHERE id = ${id}`);
      const current = rows[0];
      if (!current) return;
      yield* write(sql`
        UPDATE fork_automation_runs SET
          status = ${patch.status ?? current.status},
          reason = ${patch.reason === undefined ? current.reason : patch.reason},
          thread_key = ${patch.threadKey === undefined ? current.thread_key : patch.threadKey},
          started_at = ${patch.startedAt === undefined ? current.started_at : patch.startedAt},
          finished_at = ${patch.finishedAt === undefined ? current.finished_at : patch.finishedAt}
        WHERE id = ${id}
      `);
    });

  const runsWithStatus = (status: AutomationRunStatus) =>
    storage(
      sql<RunRow>`SELECT * FROM fork_automation_runs WHERE status = ${status} ORDER BY created_at`,
    ).pipe(Effect.map((rows) => rows.map(toRun)));

  const runsForTicket = (ticketId: string) =>
    storage(
      sql<RunRow>`SELECT * FROM fork_automation_runs WHERE ticket_id = ${ticketId} ORDER BY created_at`,
    ).pipe(Effect.map((rows) => rows.map(toRun)));

  const runningRunForThread = (threadKey: string) =>
    storage(
      sql<RunRow>`
        SELECT * FROM fork_automation_runs WHERE thread_key = ${threadKey} AND status = 'running'
      `,
    ).pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toRun)));

  const snapshot = Effect.gen(function* () {
    const automations = yield* list;
    const runs = yield* storage(
      sql<RunRow>`
        SELECT * FROM fork_automation_runs ORDER BY created_at DESC LIMIT ${SNAPSHOT_RUN_LIMIT}
      `,
    );
    return {
      automations: automations.map(({ lastFiredAt: _lastFiredAt, ...automation }) => automation),
      runs: runs.map(toRun),
      // Retained in the wire contract for older clients; column hooks no longer run.
      boardHooks: [],
    } satisfies AutomationsSnapshot;
  });

  // One-slot sliding mailbox per subscriber, as for boards: snapshots are whole states.
  const stream = Stream.callback<AutomationsSnapshot, StoreError>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* snapshot);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(() =>
            snapshot.pipe(
              Effect.matchEffect({
                onFailure: (error) => Queue.fail(mailbox, error),
                onSuccess: (next) => Effect.sync(() => Queue.offerUnsafe(mailbox, next)),
              }),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return AutomationsStore.of({
    list,
    get,
    create,
    update,
    remove,
    markFired,
    insertRun,
    updateRun,
    runsWithStatus,
    runsForTicket,
    runningRunForThread,
    snapshot,
    stream,
  });
});

export const layer = Layer.effect(AutomationsStore, make).pipe(Layer.provide(ForkDatabase.layer));

/** In-memory variant for tests. */
export const layerMemory = Layer.effect(AutomationsStore, make).pipe(
  Layer.provide(ForkDatabase.ForkDatabaseMemory),
);
