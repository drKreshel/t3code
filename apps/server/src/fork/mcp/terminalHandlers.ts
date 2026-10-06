import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { readCaller, readMutationCaller, readThread, unavailable } from "../../mcp/threadAccess.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  agentTerminalState,
  commandInput,
  DEFAULT_READ_LINES,
  plainTerminalTail,
  resolveAgentTerminalId,
} from "../terminals/agentTerminalLogic.ts";
import { AgentTerminalToolkit } from "./terminalTools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const terminalId = (name: string) => {
  const id = resolveAgentTerminalId(name.trim());
  return id === null
    ? Effect.fail(
        invalid("Terminal names use lowercase letters, digits, and dashes, up to 40 characters."),
      )
    : Effect.succeed(id);
};

const terminalFailure = (error: TerminalManager.TerminalError) =>
  error._tag === "TerminalCwdNotFoundError" || error._tag === "TerminalCwdNotDirectoryError"
    ? invalid(error.message)
    : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** Starting and stopping commands is shell access, so it follows the thread's runtime mode. */
const commandCaller = Effect.gen(function* () {
  const context = yield* readMutationCaller();
  const { caller } = context;
  if (
    caller === undefined ||
    (caller.runtimeMode !== "full-access" && caller.runtimeMode !== "auto") ||
    caller.interactionMode !== "default"
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Agent terminals require a full-access or auto calling thread in default mode.",
    });
  return { ...context, caller };
});

export const AgentTerminalToolkitHandlersLive = AgentTerminalToolkit.toLayer({
  t3_terminal_start: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* commandCaller;
      const id = yield* terminalId(input.name);
      const projects = yield* ProjectService.ProjectService;
      const terminals = yield* TerminalManager.TerminalManager;
      const path = yield* Path.Path;
      const project = yield* projects.getById(caller.projectId).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("The calling thread's project was not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const workspace = caller.worktreePath ?? project.workspaceRoot;
      const cwd = input.cwd ? path.resolve(workspace, input.cwd) : workspace;

      const current = yield* terminals
        .read({ threadId: caller.id, terminalId: id })
        .pipe(Effect.mapError(terminalFailure));
      if (agentTerminalState(current.summary) === "running")
        return yield* invalid(
          `Terminal ${id} is still running a command. Stop it with t3_terminal_stop or pick another name.`,
        );

      yield* terminals
        .open({
          threadId: caller.id,
          terminalId: id,
          cwd,
          worktreePath: caller.worktreePath,
          // Like setup scripts, the command may start before any client attaches
          // to answer color probes (Vite+ waits on truecolor replies).
          env: {
            ...projectScriptRuntimeEnv({
              project: { cwd: project.workspaceRoot },
              worktreePath: caller.worktreePath,
            }),
            COLORTERM: "",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        })
        .pipe(Effect.mapError(terminalFailure));
      yield* terminals
        .write({ threadId: caller.id, terminalId: id, data: commandInput(input.command) })
        .pipe(Effect.mapError(terminalFailure));
      return { terminalId: id, cwd };
    }),
  t3_terminal_read: (input) =>
    Effect.gen(function* () {
      const id = yield* terminalId(input.name);
      const threadId =
        input.threadId === undefined
          ? yield* readCaller().pipe(
              Effect.flatMap(({ caller }) =>
                caller === undefined
                  ? Effect.fail(invalid("Pass threadId when calling from outside a T3 thread."))
                  : Effect.succeed(caller.id),
              ),
            )
          : (yield* readThread(input.threadId)).projection.thread.id;
      const terminals = yield* TerminalManager.TerminalManager;
      const { summary, history } = yield* terminals
        .read({ threadId, terminalId: id })
        .pipe(Effect.mapError(terminalFailure));
      if (summary === null && history.length === 0)
        return yield* invalid(`No terminal ${id} exists on this thread.`);
      return {
        terminalId: id,
        state: agentTerminalState(summary),
        cwd: summary?.cwd ?? null,
        exitCode: summary?.exitCode ?? null,
        ...plainTerminalTail(history, input.lines ?? DEFAULT_READ_LINES),
      };
    }),
  t3_terminal_stop: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* commandCaller;
      const id = yield* terminalId(input.name);
      const terminals = yield* TerminalManager.TerminalManager;
      const target = { threadId: caller.id, terminalId: id };
      const current = yield* terminals.read(target).pipe(Effect.mapError(terminalFailure));
      if (current.summary === null)
        return yield* invalid(`Terminal ${id} is not open on this thread.`);
      if (input.close === true) {
        yield* terminals.close(target).pipe(Effect.mapError(terminalFailure));
        return { terminalId: id, interrupted: false, closed: true };
      }
      const running = agentTerminalState(current.summary) === "running";
      if (running)
        yield* terminals.write({ ...target, data: "\x03" }).pipe(Effect.mapError(terminalFailure));
      return { terminalId: id, interrupted: running, closed: false };
    }),
});
