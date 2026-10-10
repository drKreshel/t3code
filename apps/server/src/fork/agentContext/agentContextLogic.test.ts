import { describe, expect, it } from "@effect/vitest";

import { agentInstructions, t3Tools } from "./agentContextLogic.ts";

const session = {
  providerName: "Claude",
  interactionMode: "default" as const,
  model: "claude-opus-5-5",
  reasoningEffort: "high",
  browser: true,
  device: false,
};

describe("agentInstructions", () => {
  it("shows Claude's built-in prompt as a placeholder before T3's appended text", () => {
    const { exact, instructions } = agentInstructions({ ...session, driverKind: "claudeAgent" });
    expect(exact).toBe(true);
    expect(instructions[0]).toMatchObject({ title: "Claude Code instructions", text: null });
    expect(instructions[1]?.text).toContain("<runtime_info>");
    expect(instructions[1]?.text).toContain("<t3_terminals>");
  });

  it("lists Codex's additional context entries and the mode's developer instructions", () => {
    const { instructions } = agentInstructions({
      ...session,
      driverKind: "codex",
      interactionMode: "plan",
    });
    expect(instructions.map((instruction) => instruction.title)).toEqual([
      "Codex instructions",
      "t3_code_orchestration",
      "t3_code_runtime",
      "t3_code_tools",
      "Collaboration mode: plan",
    ]);
  });

  it("marks other providers as approximate", () => {
    const result = agentInstructions({ ...session, driverKind: "cursor", providerName: "Cursor" });
    expect(result.exact).toBe(false);
    expect(result.instructions[0]?.title).toBe("Cursor instructions");
  });
});

describe("t3Tools", () => {
  it("lists every registered tool and disables the ones settings switch off", () => {
    const tools = t3Tools({ browser: false, device: true });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.size).toBe(tools.length);
    expect(byName.get("t3_terminal_start")?.enabled).toBe(true);
    expect(byName.get("list_sidebar_folders")).toMatchObject({ enabled: true, readonly: true });
    expect(byName.get("delete_sidebar_folder")).toMatchObject({ enabled: true, readonly: false });
    expect(byName.get("preview_snapshot")?.enabled).toBe(false);
    expect(byName.get("device_screenshot")?.enabled).toBe(true);
    expect(byName.get("t3_environment_read")?.readonly).toBe(true);
  });
});
