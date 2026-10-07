import { workspaceRelativeFilePath } from "@t3tools/client-runtime/markdown-links";
import type { ProjectReadFileError } from "@t3tools/contracts";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

/** Resolve workspace links before choosing between the explorer and a file preview. */
export function resolveFilePreviewPath(path: string | null, cwd: string): string | null {
  if (path === null) return null;
  return path === "." || workspaceRelativeFilePath(path, cwd) === "." ? null : path;
}

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

/** Keep the external explorer rooted while navigating among its children. */
export function resolveHostFolderRoot(
  path: string | null,
  isDirectory: boolean,
  previousRoot: string | null,
): string | null {
  if (path === null || !isAbsolutePath(path)) return null;
  if (previousRoot !== null) {
    const relativePath = workspaceRelativeFilePath(path, previousRoot);
    if (relativePath === ".") return isDirectory ? previousRoot : null;
    if (relativePath !== null) return previousRoot;
  }
  return isDirectory ? path : null;
}

export function fileBrowserSelectedPath(
  path: string | null,
  hostRoot: string | null,
): string | null {
  if (path === null || hostRoot === null) return path;
  const relativePath = workspaceRelativeFilePath(path, hostRoot);
  return relativePath === "." ? null : relativePath;
}

/** Explorer rows stay relative internally; host links must retain their absolute location. */
export function fileBrowserLinkPath(path: string, cwd: string, absolutePaths: boolean): string {
  return absolutePaths ? resolvePathLinkTarget(path, cwd) : path;
}

/** Describe existing failure codes without exposing the underlying platform cause. */
export function filePreviewReadErrorMessage(error: ProjectReadFileError): string {
  switch (error.failure) {
    case "path_not_file":
      return "The path is a directory or special file, not a regular file.";
    case "binary_file":
      return "The file is binary and cannot be displayed as text.";
    case "workspace_path_outside_root":
      return "The requested path is outside the workspace.";
    case "resolved_path_outside_root":
      return "The path resolves to a location outside the workspace.";
    case "operation_failed":
      // A realpath failure can mean a missing path, permissions, or another I/O error.
      return error.operation === "realpath-workspace-root"
        ? "The workspace folder could not be accessed."
        : "The file could not be accessed or read. It may be missing or inaccessible.";
    default:
      return error.message;
  }
}

export function shouldShowFileExplorer(input: {
  readonly relativePath: string | null;
  readonly explorerOpen: boolean;
  readonly attachmentOpen: boolean;
  readonly hostFolderRoot?: string | null;
}): boolean {
  if (
    input.attachmentOpen ||
    (input.relativePath && isAbsolutePath(input.relativePath) && !input.hostFolderRoot)
  ) {
    return false;
  }
  return input.explorerOpen || input.relativePath === null;
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
