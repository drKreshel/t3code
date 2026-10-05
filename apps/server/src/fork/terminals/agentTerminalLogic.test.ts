import { describe, expect, it } from "@effect/vitest";

import { plainTerminalTail, resolveAgentTerminalId } from "./agentTerminalLogic.ts";

describe("resolveAgentTerminalId", () => {
  it("accepts a bare name or the full id and rejects other terminals", () => {
    expect(resolveAgentTerminalId("dev")).toBe("agent-dev");
    expect(resolveAgentTerminalId("agent-dev")).toBe("agent-dev");
    expect(resolveAgentTerminalId("term-1")).toBe("agent-term-1");
    expect(resolveAgentTerminalId("Dev Server")).toBeNull();
    expect(resolveAgentTerminalId("agent-")).toBeNull();
  });
});

describe("plainTerminalTail", () => {
  it("strips escapes, keeps the last state of redrawn lines, and returns the tail", () => {
    const history =
      "\x1b[32m$ pnpm dev\x1b[0m\r\n" +
      "progress 10%\rprogress 50%\rprogress 100%\r\n" +
      "\x1b]0;title\x07ready on :5173\r\n\r\n";
    expect(plainTerminalTail(history, 10)).toEqual({
      output: "$ pnpm dev\nprogress 100%\nready on :5173",
      truncated: false,
    });
    expect(plainTerminalTail(history, 1)).toEqual({ output: "ready on :5173", truncated: true });
  });
});
