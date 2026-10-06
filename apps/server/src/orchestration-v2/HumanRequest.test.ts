import { describe, expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { humanRequestEvents } from "./HumanRequest.ts";

const questionsOf = (events: ReturnType<typeof humanRequestEvents>) => {
  const item = events.find((event) => event.type === "turn-item.updated");
  return item?.payload.type === "user_input_request" ? item.payload.questions : [];
};

describe("humanRequestEvents", () => {
  const base = {
    type: "thread.request-human" as const,
    commandId: CommandId.make("request-human:test"),
    threadId: ThreadId.make("thread-1"),
    reason: "## Update stopped\n\n- Upstream ships its own automations.",
  };
  const now = DateTime.makeUnsafe(0);

  it("offers exactly the ways forward the agent gave", () => {
    const options = [
      { label: "Keep fork automations", description: "Drop upstream's version." },
      { label: "Adopt upstream", description: "Migrate fork automations onto it." },
    ];
    const [question] = questionsOf(humanRequestEvents({ ...base, options }, now, 1));
    expect(question).toMatchObject({ question: base.reason, allowCustomAnswer: true, options });
  });

  it("offers no canned answer when the agent gave no options", () => {
    const [question] = questionsOf(humanRequestEvents(base, now, 1));
    expect(question?.options).toEqual([]);
    expect(question?.allowCustomAnswer).toBe(true);
  });
});
