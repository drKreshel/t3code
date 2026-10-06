/**
 * Fork: a thread's agent context, for the "Agent context" panel. Reads the
 * thread, its provider instance, and the effective project settings, then
 * rebuilds the session-start instructions and the T3 tool list.
 */
import {
  AgentContextError,
  PROVIDER_DISPLAY_NAMES,
  type ThreadAgentContext,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { agentInstructions, t3Tools } from "./agentContextLogic.ts";

const unavailable = () =>
  new AgentContextError({
    code: "unavailable",
    message: "The agent context could not be read.",
  });

export const makeThreadAgentContext = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  return Effect.fn("AgentContext.thread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<ThreadAgentContext, AgentContextError> {
    const thread = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (thread === null)
      return yield* new AgentContextError({ code: "not-found", message: "Thread not found." });
    const instance = yield* providers.getInstance(thread.modelSelection.instanceId);
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
    const effective = resolveProjectSettings(settings, thread.projectId).settings;
    const access = {
      browser: effective.enableAgentBrowserAccess,
      device: effective.enableAgentDeviceAccess,
    };
    const providerName =
      (instance && PROVIDER_DISPLAY_NAMES[instance.driverKind]) ??
      instance?.displayName ??
      "The provider";
    const { exact, instructions } = agentInstructions({
      driverKind: instance?.driverKind ?? "",
      providerName,
      interactionMode: thread.interactionMode,
      model: thread.modelSelection.model,
      reasoningEffort: getModelSelectionStringOptionValue(thread.modelSelection, "reasoningEffort"),
      ...access,
    });
    return { providerName, exact, instructions, tools: t3Tools(access) };
  });
});
