/**
 * Sidebar folders scheduled tasks file their runs' chats into (fork feature).
 * Stored in the environment's `fork.sqlite`; each client creates the folder
 * and files the chats, as for ticket folders.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ScheduledTaskId } from "./baseSchemas.ts";
import { TicketFolderPath } from "./forkBoards.ts";

export const FORK_TASK_FOLDERS_WS_METHODS = {
  subscribe: "fork.taskFolders.subscribe",
  set: "fork.taskFolders.set",
} as const;

/** A task's folder and the chats its runs started or posted in, as scoped thread keys. */
export const TaskFolderRoute = Schema.Struct({
  taskId: ScheduledTaskId,
  folder: TicketFolderPath,
  threadKeys: Schema.Array(Schema.String),
});
export type TaskFolderRoute = typeof TaskFolderRoute.Type;

/** Every task with a folder; streamed whole after each change or run. */
export const TaskFoldersSnapshot = Schema.Struct({ routes: Schema.Array(TaskFolderRoute) });
export type TaskFoldersSnapshot = typeof TaskFoldersSnapshot.Type;

export const SetTaskFolderInput = Schema.Struct({
  taskId: ScheduledTaskId,
  /** Null stops filing; chats already filed stay where they are. */
  folder: Schema.NullOr(TicketFolderPath),
});
export type SetTaskFolderInput = typeof SetTaskFolderInput.Type;

export class TaskFoldersError extends Schema.TaggedError<TaskFoldersError>()("TaskFoldersError", {
  message: Schema.String,
}) {}

export const ForkTaskFoldersSubscribeRpc = Rpc.make(FORK_TASK_FOLDERS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: TaskFoldersSnapshot,
  error: Schema.Union([TaskFoldersError, EnvironmentAuthorizationError]),
  stream: true,
});

export const ForkTaskFoldersSetRpc = Rpc.make(FORK_TASK_FOLDERS_WS_METHODS.set, {
  payload: SetTaskFolderInput,
  error: Schema.Union([TaskFoldersError, EnvironmentAuthorizationError]),
});
