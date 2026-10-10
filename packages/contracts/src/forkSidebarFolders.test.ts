import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
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

  it("transports thread filing results", () => {
    const reply = {
      clientId: "web",
      connectionId: "connection",
      requestId: "request",
      result: {
        type: "thread-moved" as const,
        thread: {
          environmentId: EnvironmentId.make("environment"),
          threadId: ThreadId.make("thread"),
        },
        folderId: "folder",
      },
    };
    expect(decodeReply(encodeReply(reply)).result).toEqual(reply.result);
  });

  it("transports folder settlement results", () => {
    const reply = {
      clientId: "web",
      connectionId: "connection",
      requestId: "request",
      result: {
        type: "folder-settled" as const,
        folderId: "folder",
        settled: true,
      },
    };
    expect(decodeReply(encodeReply(reply)).result).toEqual(reply.result);
  });

  it("transports folder image icon changes", () => {
    const reply = {
      clientId: "web",
      connectionId: "connection",
      requestId: "request",
      result: {
        type: "folder-icon-updated" as const,
        folderId: "folder",
        icon: { kind: "image" as const, dataUrl: "data:image/png;base64,aWNvbg==" },
      },
    };
    expect(decodeReply(encodeReply(reply)).result).toEqual(reply.result);
  });
});
