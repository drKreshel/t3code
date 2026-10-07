/**
 * WebSocket handlers for fork RPCs, spread into `WsRpcGroup.of({...})` in
 * `ws.ts`. The group's middleware authorizes and traces them like upstream
 * methods (see `RpcAuthorization` and `RpcInstrumentation`).
 */
import {
  BoardsCommandError,
  type BoardsCommand,
  FORK_AGENT_CONTEXT_WS_METHODS,
  FORK_SKILLS_WS_METHODS,
  type SkillFile,
  SkillsError,
  type SkillsSettings,
  FORK_BOARDS_WS_METHODS,
  FORK_TASK_FOLDERS_WS_METHODS,
  FORK_TEMPLATES_WS_METHODS,
  type SetTaskFolderInput,
  TaskFoldersError,
  FORK_WORKSPACES_WS_METHODS,
  FORK_THREAD_PINS_WS_METHODS,
  type TemplatesCommand,
  type ThreadPinsCommand,
  ThreadPinsError,
  type ThreadId,
  type WorkspacesCommand,
  WorkspacesCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeThreadAgentContext } from "./agentContext/AgentContext.ts";
import { BoardsService } from "./boards/BoardsService.ts";
import { SkillsService } from "./skills/SkillsService.ts";
import { ThreadPinsService } from "./threadPins/ThreadPinsService.ts";
import { TaskFolders } from "./taskFolders/TaskFolders.ts";
import { BoardTemplates } from "./templates/BoardTemplates.ts";
import { TicketWorkspaces } from "./workspaces/TicketWorkspaces.ts";

const skillsUnavailable = new SkillsError({
  code: "storage",
  message: "Skills are not available on this server.",
});

const workspacesUnavailable = new WorkspacesCommandError({
  code: "storage",
  message: "Ticket workspaces are not available on this server.",
});

const pinsUnavailable = new ThreadPinsError({
  code: "storage",
  message: "Chat pins are not available on this server.",
});
const taskFoldersUnavailable = new TaskFoldersError({
  message: "Task folders are not available on this server.",
});

const unavailable = new BoardsCommandError({
  code: "storage",
  message: "Boards are not available on this server.",
});
/** Stands in where the runtime does not provide BoardsService, such as upstream's server tests. */
export const unavailableBoards: BoardsService["Service"] = {
  snapshot: Effect.fail(unavailable),
  stream: Stream.fail(unavailable),
  ticketDetailStream: () => Stream.fail(unavailable),
  dispatch: () => Effect.fail(unavailable),
};

export const makeForkRpcHandlers = () =>
  Effect.gen(function* () {
    // Optional so runtimes that do not provide fork services (upstream's own
    // server tests) still build; there, fork methods report unavailability.
    const maybeBoards = yield* Effect.serviceOption(BoardsService);
    const boards = Option.getOrElse(maybeBoards, () => unavailableBoards);
    const workspaces = yield* Effect.serviceOption(TicketWorkspaces);
    const templates = yield* Effect.serviceOption(BoardTemplates);
    const taskFolders = yield* Effect.serviceOption(TaskFolders);
    const threadAgentContext = yield* makeThreadAgentContext;
    const skills = yield* Effect.serviceOption(SkillsService);
    const pins = yield* Effect.serviceOption(ThreadPinsService);
    const withSkills = <A>(
      run: (service: SkillsService["Service"]) => Effect.Effect<A, SkillsError>,
    ): Effect.Effect<A, SkillsError> =>
      Option.match(skills, {
        onNone: () => Effect.fail(skillsUnavailable),
        onSome: run,
      });
    return {
      [FORK_SKILLS_WS_METHODS.list]: () => withSkills((service) => service.list),
      [FORK_SKILLS_WS_METHODS.read]: (input: { readonly path: string }) =>
        withSkills((service) => service.read(input.path)),
      [FORK_SKILLS_WS_METHODS.save]: (file: SkillFile) =>
        withSkills((service) => service.save(file)),
      [FORK_SKILLS_WS_METHODS.saveSettings]: (settings: SkillsSettings) =>
        withSkills((service) => service.saveSettings(settings)),
      [FORK_AGENT_CONTEXT_WS_METHODS.thread]: (input: { readonly threadId: ThreadId }) =>
        threadAgentContext(input.threadId),
      [FORK_BOARDS_WS_METHODS.subscribe]: () => boards.stream,
      [FORK_BOARDS_WS_METHODS.subscribeTicket]: (input: { readonly ticketId: string }) =>
        boards.ticketDetailStream(input.ticketId),
      [FORK_BOARDS_WS_METHODS.dispatch]: (command: BoardsCommand) =>
        boards.dispatch(command, "user"),
      [FORK_WORKSPACES_WS_METHODS.subscribe]: () =>
        Option.match(workspaces, {
          onNone: () => Stream.fail(workspacesUnavailable),
          onSome: (service) => service.stream,
        }),
      [FORK_WORKSPACES_WS_METHODS.dispatch]: (command: WorkspacesCommand) =>
        Option.match(workspaces, {
          onNone: () => Effect.fail(workspacesUnavailable),
          onSome: (service) => service.dispatch(command),
        }),
      [FORK_WORKSPACES_WS_METHODS.listRepos]: (input: { readonly projectKey: string }) =>
        Option.match(workspaces, {
          onNone: () => Effect.fail(workspacesUnavailable),
          onSome: (service) => service.listRepos(input.projectKey),
        }),
      [FORK_THREAD_PINS_WS_METHODS.subscribe]: (input: { readonly threadId: ThreadId }) =>
        Option.match(pins, {
          onNone: () => Stream.fail(pinsUnavailable),
          onSome: (service) => service.stream(input.threadId),
        }),
      [FORK_THREAD_PINS_WS_METHODS.dispatch]: (command: ThreadPinsCommand) =>
        Option.match(pins, {
          onNone: () => Effect.fail(pinsUnavailable),
          onSome: (service) => service.dispatch(command),
        }),
      [FORK_TEMPLATES_WS_METHODS.subscribe]: () =>
        Option.match(templates, {
          onNone: () => Stream.fail(unavailable),
          onSome: (service) => service.stream,
        }),
      [FORK_TEMPLATES_WS_METHODS.dispatch]: (command: TemplatesCommand) =>
        Option.match(templates, {
          onNone: () => Effect.fail(unavailable),
          onSome: (service) => service.dispatch(command, "user"),
        }),
      [FORK_TASK_FOLDERS_WS_METHODS.subscribe]: () =>
        Option.match(taskFolders, {
          onNone: () => Stream.fail(taskFoldersUnavailable),
          onSome: (service) => service.stream,
        }),
      [FORK_TASK_FOLDERS_WS_METHODS.set]: (input: SetTaskFolderInput) =>
        Option.match(taskFolders, {
          onNone: () => Effect.fail(taskFoldersUnavailable),
          onSome: (service) => service.set(input),
        }),
    };
  });
