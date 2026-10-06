/**
 * WebSocket handlers for fork RPCs, spread into `WsRpcGroup.of({...})` in
 * `ws.ts`. The observers are ws.ts's own, so fork methods get the same
 * authorization and tracing as upstream ones.
 */
import {
  AutomationsCommandError,
  type AutomationsCommand,
  BoardsCommandError,
  type BoardsCommand,
  FORK_AGENT_CONTEXT_WS_METHODS,
  FORK_AUTOMATIONS_WS_METHODS,
  FORK_SKILLS_WS_METHODS,
  type SkillFile,
  SkillsError,
  type SkillsSettings,
  type EnvironmentAuthorizationError,
  FORK_BOARDS_WS_METHODS,
  FORK_TEMPLATES_WS_METHODS,
  FORK_WORKSPACES_WS_METHODS,
  type TemplatesCommand,
  type ThreadId,
  type WorkspacesCommand,
  WorkspacesCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeThreadAgentContext } from "./agentContext/AgentContext.ts";
import { AutomationEngine } from "./automations/AutomationEngine.ts";
import { AutomationsStore } from "./automations/AutomationsStore.ts";
import { BoardsService } from "./boards/BoardsService.ts";
import { SkillsService } from "./skills/SkillsService.ts";
import { BoardTemplates } from "./templates/BoardTemplates.ts";
import { TicketWorkspaces } from "./workspaces/TicketWorkspaces.ts";

interface RpcObservers {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStream: <A, E, R>(
    method: string,
    stream: Stream.Stream<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<A, E | EnvironmentAuthorizationError, R>;
}

const TRACE = { "rpc.aggregate": "fork-boards" } as const;
const AUTOMATIONS_TRACE = { "rpc.aggregate": "fork-automations" } as const;
const WORKSPACES_TRACE = { "rpc.aggregate": "fork-workspaces" } as const;

const SKILLS_TRACE = { "rpc.aggregate": "fork-skills" } as const;

const skillsUnavailable = new SkillsError({
  code: "storage",
  message: "Skills are not available on this server.",
});

const workspacesUnavailable = new WorkspacesCommandError({
  code: "storage",
  message: "Ticket workspaces are not available on this server.",
});

const automationsUnavailable = new AutomationsCommandError({
  code: "storage",
  message: "Automations are not available on this server.",
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

export const makeForkRpcHandlers = ({ observeRpcEffect, observeRpcStream }: RpcObservers) =>
  Effect.gen(function* () {
    // Optional so runtimes that do not provide fork services (upstream's own
    // server tests) still build; there, fork methods report unavailability.
    const maybeBoards = yield* Effect.serviceOption(BoardsService);
    const boards = Option.getOrElse(maybeBoards, () => unavailableBoards);
    const automationsStore = yield* Effect.serviceOption(AutomationsStore);
    const automationEngine = yield* Effect.serviceOption(AutomationEngine);
    const workspaces = yield* Effect.serviceOption(TicketWorkspaces);
    const templates = yield* Effect.serviceOption(BoardTemplates);
    const threadAgentContext = yield* makeThreadAgentContext;
    const skills = yield* Effect.serviceOption(SkillsService);
    const withSkills = <A>(
      run: (service: SkillsService["Service"]) => Effect.Effect<A, SkillsError>,
    ): Effect.Effect<A, SkillsError> =>
      Option.match(skills, {
        onNone: () => Effect.fail(skillsUnavailable),
        onSome: run,
      });
    return {
      [FORK_SKILLS_WS_METHODS.list]: () =>
        observeRpcEffect(
          FORK_SKILLS_WS_METHODS.list,
          withSkills((service) => service.list),
          SKILLS_TRACE,
        ),
      [FORK_SKILLS_WS_METHODS.read]: (input: { readonly path: string }) =>
        observeRpcEffect(
          FORK_SKILLS_WS_METHODS.read,
          withSkills((service) => service.read(input.path)),
          SKILLS_TRACE,
        ),
      [FORK_SKILLS_WS_METHODS.save]: (file: SkillFile) =>
        observeRpcEffect(
          FORK_SKILLS_WS_METHODS.save,
          withSkills((service) => service.save(file)),
          SKILLS_TRACE,
        ),
      [FORK_SKILLS_WS_METHODS.saveSettings]: (settings: SkillsSettings) =>
        observeRpcEffect(
          FORK_SKILLS_WS_METHODS.saveSettings,
          withSkills((service) => service.saveSettings(settings)),
          SKILLS_TRACE,
        ),
      [FORK_AGENT_CONTEXT_WS_METHODS.thread]: (input: { readonly threadId: ThreadId }) =>
        observeRpcEffect(FORK_AGENT_CONTEXT_WS_METHODS.thread, threadAgentContext(input.threadId), {
          "rpc.aggregate": "fork-agent-context",
        }),
      [FORK_BOARDS_WS_METHODS.subscribe]: () =>
        observeRpcStream(FORK_BOARDS_WS_METHODS.subscribe, boards.stream, TRACE),
      [FORK_BOARDS_WS_METHODS.subscribeTicket]: (input: { readonly ticketId: string }) =>
        observeRpcStream(
          FORK_BOARDS_WS_METHODS.subscribeTicket,
          boards.ticketDetailStream(input.ticketId),
          TRACE,
        ),
      [FORK_BOARDS_WS_METHODS.dispatch]: (command: BoardsCommand) =>
        observeRpcEffect(FORK_BOARDS_WS_METHODS.dispatch, boards.dispatch(command, "user"), TRACE),
      [FORK_AUTOMATIONS_WS_METHODS.subscribe]: () =>
        observeRpcStream(
          FORK_AUTOMATIONS_WS_METHODS.subscribe,
          Option.match(automationsStore, {
            onNone: () => Stream.fail(automationsUnavailable),
            onSome: (store) => store.stream,
          }),
          AUTOMATIONS_TRACE,
        ),
      [FORK_AUTOMATIONS_WS_METHODS.dispatch]: (command: AutomationsCommand) =>
        observeRpcEffect(
          FORK_AUTOMATIONS_WS_METHODS.dispatch,
          Option.match(automationEngine, {
            onNone: () => Effect.fail(automationsUnavailable),
            onSome: (engine) => engine.dispatch(command),
          }),
          AUTOMATIONS_TRACE,
        ),
      [FORK_WORKSPACES_WS_METHODS.subscribe]: () =>
        observeRpcStream(
          FORK_WORKSPACES_WS_METHODS.subscribe,
          Option.match(workspaces, {
            onNone: () => Stream.fail(workspacesUnavailable),
            onSome: (service) => service.stream,
          }),
          WORKSPACES_TRACE,
        ),
      [FORK_WORKSPACES_WS_METHODS.dispatch]: (command: WorkspacesCommand) =>
        observeRpcEffect(
          FORK_WORKSPACES_WS_METHODS.dispatch,
          Option.match(workspaces, {
            onNone: () => Effect.fail(workspacesUnavailable),
            onSome: (service) => service.dispatch(command),
          }),
          WORKSPACES_TRACE,
        ),
      [FORK_WORKSPACES_WS_METHODS.listRepos]: (input: { readonly projectKey: string }) =>
        observeRpcEffect(
          FORK_WORKSPACES_WS_METHODS.listRepos,
          Option.match(workspaces, {
            onNone: () => Effect.fail(workspacesUnavailable),
            onSome: (service) => service.listRepos(input.projectKey),
          }),
          WORKSPACES_TRACE,
        ),
      [FORK_TEMPLATES_WS_METHODS.subscribe]: () =>
        observeRpcStream(
          FORK_TEMPLATES_WS_METHODS.subscribe,
          Option.match(templates, {
            onNone: () => Stream.fail(unavailable),
            onSome: (service) => service.stream,
          }),
          TRACE,
        ),
      [FORK_TEMPLATES_WS_METHODS.dispatch]: (command: TemplatesCommand) =>
        observeRpcEffect(
          FORK_TEMPLATES_WS_METHODS.dispatch,
          Option.match(templates, {
            onNone: () => Effect.fail(unavailable),
            onSome: (service) => service.dispatch(command, "user"),
          }),
          TRACE,
        ),
    };
  });
