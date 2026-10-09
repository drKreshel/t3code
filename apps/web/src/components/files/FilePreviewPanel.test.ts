import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProjectReadFileError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  fileBrowserLinkPath,
  fileBrowserSelectedPath,
  filePreviewReadErrorMessage,
  isMarkdownPreviewFile,
  resolveFilePreviewPath,
  resolveHostFolderRoot,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
  workspaceAssetResource,
} from "./filePreviewMode";

const decodeReadError = Schema.decodeSync(ProjectReadFileError);

describe("file preview read errors", () => {
  it.each([
    ["path_not_file", "The path is a directory or special file, not a regular file."],
    ["binary_file", "The file is binary and cannot be displayed as text."],
    ["workspace_path_outside_root", "The requested path is outside the workspace."],
    ["resolved_path_outside_root", "The path resolves to a location outside the workspace."],
    [
      "operation_failed",
      "The file could not be accessed or read. It may be missing or inaccessible.",
    ],
  ] as const)("describes %s without revealing the platform cause", (failure, message) => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "workspace/outline.md",
      failure,
      operation: "realpath-target",
      resolvedPath: "/workspace/workspace/outline.md",
      cause: new Error("EACCES: sensitive platform detail"),
    });
    expect(filePreviewReadErrorMessage(error)).toBe(message);
  });

  it("distinguishes an inaccessible workspace from an inaccessible file", () => {
    const error = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "outline.md",
      failure: "operation_failed",
      operation: "realpath-workspace-root",
      operationPath: "/workspace",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("The workspace folder could not be accessed.");
  });

  it("preserves the public message from older servers", () => {
    const error = decodeReadError({
      _tag: "ProjectReadFileError",
      message: "Legacy file read failure.",
    });
    expect(filePreviewReadErrorMessage(error)).toBe("Legacy file read failure.");
  });
});

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("shows a confirmed host folder and respects the explorer toggle for its child files", () => {
    const hostFolderRoot = "/tmp/sdf-ui";
    expect(
      shouldShowFileExplorer({
        relativePath: null,
        explorerOpen: false,
        attachmentOpen: false,
        hostFolderRoot,
      }),
    ).toBe(true);
    for (const explorerOpen of [false, true]) {
      expect(
        shouldShowFileExplorer({
          relativePath: "/tmp/sdf-ui/preview.png",
          explorerOpen,
          attachmentOpen: false,
          hostFolderRoot,
        }),
      ).toBe(explorerOpen);
    }
  });

  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("host folder navigation", () => {
  it.each(["/tmp/sdf-ui", "/tmp/assets.png", "/tmp/docs.md"])(
    "browses %s, opens children by their absolute path, and returns to the folder",
    (folder) => {
      const root = resolveHostFolderRoot(folder, true, null);
      expect(root).toBe(folder);
      expect(fileBrowserSelectedPath(folder, root)).toBeNull();
      const file = fileBrowserLinkPath("nested/preview.png", folder, true);
      expect(file).toBe(`${folder}/nested/preview.png`);
      expect(resolveHostFolderRoot(file, false, root)).toBe(folder);
      expect(fileBrowserSelectedPath(file, root)).toBe("nested/preview.png");
      expect(resolveHostFolderRoot(`${folder}/nested`, true, root)).toBe(folder);
      expect(resolveHostFolderRoot(folder, true, root)).toBe(folder);
    },
  );

  it("requires directory confirmation and clears the root on unrelated navigation", () => {
    expect(resolveHostFolderRoot("/tmp/pipe", false, null)).toBeNull();
    expect(resolveHostFolderRoot("/tmp/sdf-ui", false, "/tmp/sdf-ui")).toBeNull();
    expect(resolveHostFolderRoot("/tmp/sdf-ui-other/image.png", false, "/tmp/sdf-ui")).toBeNull();
    expect(resolveHostFolderRoot("src/main.ts", false, "/tmp/sdf-ui")).toBeNull();
    expect(resolveHostFolderRoot(null, false, "/tmp/sdf-ui")).toBeNull();
    expect(resolveHostFolderRoot("/tmp/other", true, "/tmp/sdf-ui")).toBe("/tmp/other");
    expect(fileBrowserLinkPath("src/main.ts", "/repo", false)).toBe("src/main.ts");
  });

  it("maps Windows host paths to relative tree rows without changing the root", () => {
    const root = "C:\\Temp\\sdf-ui";
    const file = fileBrowserLinkPath("nested/preview.png", root, true);
    expect(file).toBe("C:\\Temp\\sdf-ui\\nested\\preview.png");
    expect(fileBrowserSelectedPath(file, root)).toBe("nested/preview.png");
    expect(resolveHostFolderRoot(file.toLowerCase(), false, root)).toBe(root);
    expect(resolveHostFolderRoot("C:\\Temp\\sdf-ui-other", false, root)).toBeNull();
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("resolveFilePreviewPath", () => {
  it.each([
    ["/repo/project", null],
    ["/repo/project/", null],
    [".", null],
    [null, null],
    ["/repo/project/src", "/repo/project/src"],
    ["/repo/project/src/main.ts", "/repo/project/src/main.ts"],
    ["src/main.ts", "src/main.ts"],
    ["/repo/project-other", "/repo/project-other"],
  ])("opens %s in the appropriate workspace surface", (path, expected) => {
    const relativePath = resolveFilePreviewPath(path, "/repo/project");
    expect(relativePath).toBe(expected);
    if (expected === null) {
      expect(
        shouldShowFileExplorer({ relativePath, explorerOpen: false, attachmentOpen: false }),
      ).toBe(true);
    }
  });
});

describe("workspaceAssetResource", () => {
  const input = {
    kind: "workspace-file" as const,
    threadRef: {
      environmentId: "env" as ScopedThreadRef["environmentId"],
      threadId: "thread-1" as ScopedThreadRef["threadId"],
    },
    workspaceRoot: "/repo",
    absolutePath: "/repo/docs/index.html",
  };

  it("names the thread once the server knows it", () => {
    expect(workspaceAssetResource({ ...input, draft: false })).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/repo/docs/index.html",
    });
  });

  it("names the workspace root for a draft, which the server cannot resolve from a thread", () => {
    expect(workspaceAssetResource({ ...input, draft: true })).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "/repo/docs/index.html",
    });
  });
});
