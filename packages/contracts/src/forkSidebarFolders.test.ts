import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SidebarFolderReply, SidebarFoldersError } from "./forkSidebarFolders.ts";

const encodeReply = Schema.encodeSync(Schema.toCodecJson(SidebarFolderReply));
const decodeReply = Schema.decodeUnknownSync(Schema.toCodecJson(SidebarFolderReply));

describe("sidebar folder error transport", () => {
  it("preserves retry guidance in replies sent over the wire", () => {
    const reply = {
      clientId: "web",
      connectionId: "connection",
      requestId: "request",
      error: SidebarFoldersError.fromCode("timeout"),
    };
    const wire = encodeReply(reply);
    expect(wire).toMatchObject({
      error: {
        code: "timeout",
        message:
          "The sidebar folder client did not respond in time. List folders again before retrying.",
      },
    });
    expect(decodeReply(wire).error?.message).toBe(reply.error.message);
  });
});
