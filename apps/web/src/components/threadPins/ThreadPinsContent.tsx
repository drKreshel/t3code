import type { ScopedThreadRef, ThreadPin, ThreadPins } from "@t3tools/contracts";
import { GlobeIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { isUrlPinTarget, useThreadPinsDispatch } from "../../state/threadPins";
import { formatRelativeTimeLabel } from "../../timestampFormat";
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

/**
 * A chat's note and pinned artifacts, shared by the thread details card and
 * the ticket page. Reads in full without clicking; files and URLs open on click.
 * The note comes last and scrolls on its own when it outgrows the screen.
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
  return (
    <div className="flex flex-col gap-1">
      {pins.pins.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {pins.pins.map((pin) => (
            <PinRow
              key={pin.id}
              pin={pin}
              onOpen={() =>
                isUrlPinTarget(pin.target) ? onOpenUrl(pin.target) : onOpenFile(pin.target)
              }
              onUnpin={() =>
                void dispatch({ type: "pin.remove", threadId: threadRef.threadId, pinId: pin.id })
              }
            />
          ))}
        </ul>
      ) : null}
      {pins.note ? (
        <PinnedNote
          text={pins.note.text}
          updatedAt={pins.note.updatedAt}
          onSave={(text) => dispatch({ type: "note.set", threadId: threadRef.threadId, text })}
        />
      ) : null}
    </div>
  );
}

function PinnedNote({
  text,
  updatedAt,
  onSave,
}: {
  readonly text: string;
  readonly updatedAt: string;
  readonly onSave: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const save = () => {
      setDraft(null);
      if (draft.trim() !== text) void onSave(draft);
    };
    return (
      <div className="flex flex-col gap-1.5 px-1">
        <Textarea
          size="sm"
          autoFocus
          aria-label="Chat note"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(null);
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
          }}
        />
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button size="xs" onClick={save}>
            {draft.trim().length === 0 ? "Clear note" : "Save"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/note relative rounded-lg px-2.5 py-1.5">
      <p className="max-h-[40dvh] overflow-y-auto overscroll-contain pe-5 text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
        {text}
      </p>
      <p className="mt-1 text-2xs text-muted-foreground">
        Updated {formatRelativeTimeLabel(updatedAt)}
      </p>
      <span className="absolute top-1 right-1 opacity-0 group-hover/note:opacity-100 focus-within:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Edit note"
          onClick={() => setDraft(text)}
        >
          <PencilIcon />
        </Button>
      </span>
    </div>
  );
}

function PinRow({
  pin,
  onOpen,
  onUnpin,
}: {
  readonly pin: ThreadPin;
  readonly onOpen: () => void;
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
              onClick={onOpen}
              className={cn(
                "flex h-full min-w-0 flex-1 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            />
          }
        >
          {isUrlPinTarget(pin.target) ? (
            <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <PierreEntryIcon pathValue={pin.target} kind="file" theme={resolvedTheme} />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
            {pin.title}
          </span>
          <span className="max-w-[40%] shrink truncate text-2xs text-muted-foreground group-hover/pin:hidden">
            {pinTargetLabel(pin.target)}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-96 break-all">
          {pin.target}
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
