import type { ScopedThreadRef, ThreadPin, ThreadPins } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { GlobeIcon, PencilIcon, StickyNoteIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { useProject, useServerConfigs, useThreadShell } from "../../state/entities";
import { isUrlPinTarget, useThreadPinsDispatch } from "../../state/threadPins";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The last path segment, or the host and path of a URL, for a pin's tooltip line. */
function pinTargetLabel(target: string): string {
  if (isUrlPinTarget(target)) return target.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return target.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? target;
}

/** What chat markdown needs to show file links and `$skill` names as chips. */
function useThreadMarkdownContext(threadRef: ScopedThreadRef) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  const serverConfig = useServerConfigs().get(threadRef.environmentId) ?? null;
  const instanceId = thread?.modelSelection.instanceId;
  const worktreePath = thread?.worktreePath ?? null;
  return useMemo(() => {
    const cwd =
      project === null
        ? undefined
        : projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath });
    const provider = serverConfig?.providers.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    return { cwd, skills: provider ? resolveProviderSkillsForCwd(provider, cwd) : [] };
  }, [instanceId, project, serverConfig, worktreePath]);
}

/**
 * A chat's pins, shared by the thread details card and the ticket page, in
 * the order they were pinned. Notes read in full without clicking and scroll
 * on their own past 40% of the screen; files and URLs open on click.
 */
export function ThreadPinsContent({
  threadRef,
  pins,
  onOpenFile,
  onOpenUrl,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly pins: ThreadPins;
  readonly onOpenFile: (path: string) => void;
  readonly onOpenUrl: (url: string) => void;
}) {
  const dispatch = useThreadPinsDispatch(threadRef.environmentId);
  const markdown = useThreadMarkdownContext(threadRef);
  const unpin = (pin: ThreadPin) =>
    void dispatch({ type: "pin.remove", threadId: threadRef.threadId, pinId: pin.id });
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {pins.pins.map((pin) =>
        pin.text !== null ? (
          <NoteRow
            key={pin.id}
            pin={pin}
            text={pin.text}
            threadRef={threadRef}
            markdown={markdown}
            onSave={(text) =>
              text.length === 0
                ? unpin(pin)
                : void dispatch({
                    type: "note.set",
                    threadId: threadRef.threadId,
                    title: pin.title,
                    text,
                  })
            }
            onUnpin={() => unpin(pin)}
          />
        ) : pin.target !== null ? (
          <PinRow
            key={pin.id}
            pin={pin}
            target={pin.target}
            onOpen={(target) => (isUrlPinTarget(target) ? onOpenUrl(target) : onOpenFile(target))}
            onUnpin={() => unpin(pin)}
          />
        ) : null,
      )}
    </ul>
  );
}

function NoteRow({
  pin,
  text,
  threadRef,
  markdown,
  onSave,
  onUnpin,
}: {
  readonly pin: ThreadPin;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly markdown: ReturnType<typeof useThreadMarkdownContext>;
  readonly onSave: (text: string) => void;
  readonly onUnpin: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (value: string) => {
    setDraft(null);
    if (value.trim() !== text) onSave(value.trim());
  };
  return (
    <li className="group/note rounded-lg py-1.5">
      <div className={cn("flex min-h-5 items-center", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}>
        <StickyNoteIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
          {pin.title}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground group-hover/note:hidden">
          {formatRelativeTimeLabel(pin.updatedAt)}
        </span>
        <span className="-my-1 hidden shrink-0 group-hover/note:flex focus-within:flex">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${pin.title}`}
            onClick={() => setDraft(text)}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Unpin ${pin.title}`}
            onClick={onUnpin}
          >
            <XIcon />
          </Button>
        </span>
      </div>
      {draft !== null ? (
        <div className="flex flex-col gap-1.5 px-2.5 pt-1.5">
          <Textarea
            size="sm"
            autoFocus
            aria-label={pin.title}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(null);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save(draft);
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => save(draft)}>
              {draft.trim().length === 0 ? "Unpin note" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 max-h-[40dvh] overflow-y-auto overscroll-contain ps-9 pe-2.5">
          {/* Agents write notes line by line, so single newlines stay breaks. */}
          <ChatMarkdown
            text={text}
            cwd={markdown.cwd}
            threadRef={threadRef}
            skills={markdown.skills}
            lineBreaks
            isStreaming={false}
            className="text-xs"
          />
        </div>
      )}
    </li>
  );
}

function PinRow({
  pin,
  target,
  onOpen,
  onUnpin,
}: {
  readonly pin: ThreadPin;
  readonly target: string;
  readonly onOpen: (target: string) => void;
  readonly onUnpin: () => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <li className="group/pin flex h-8 items-center rounded-lg hover:bg-black/[0.055] dark:hover:bg-white/[0.075]">
      <Tooltip>
        <TooltipTrigger
          delay={300}
          render={
            <button
              type="button"
              onClick={() => onOpen(target)}
              className={cn(
                "flex h-full min-w-0 flex-1 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            />
          }
        >
          {isUrlPinTarget(target) ? (
            <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <PierreEntryIcon pathValue={target} kind="file" theme={resolvedTheme} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
            {pin.title}
          </span>
          <span className="max-w-[40%] shrink truncate text-2xs text-muted-foreground group-hover/pin:hidden">
            {pinTargetLabel(target)}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-96 break-all">
          {target}
        </TooltipPopup>
      </Tooltip>
      <span className="hidden pe-1 group-hover/pin:block focus-within:block">
        <Button size="icon-xs" variant="ghost" aria-label={`Unpin ${pin.title}`} onClick={onUnpin}>
          <XIcon />
        </Button>
      </span>
    </li>
  );
}
