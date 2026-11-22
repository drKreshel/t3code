import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  CornerDownRightIcon,
  CornerLeftUpIcon,
  SearchIcon,
} from "lucide-react";
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  closeRelocateThreadDialog,
  relocateThreadDialogTargetsAtom,
} from "./relocateThreadDialogState";
import {
  canMoveThreadToTopLevel,
  canRelocateThread,
  rankRelocationParentCandidates,
} from "./relocateThreadLogic";

export function RelocateThreadDialogHost() {
  const targets = useAtomValue(relocateThreadDialogTargetsAtom);
  if (targets === null || targets.length === 0) return null;
  const key = targets.map((target) => `${target.environmentId}:${target.threadId}`).join("|");
  return <RelocateThreadDialog key={key} targets={targets} onClose={closeRelocateThreadDialog} />;
}

function RelocateThreadDialog(props: {
  readonly targets: ReadonlyArray<ScopedThreadRef>;
  readonly onClose: () => void;
}) {
  const allThreads = useQuietThreadShells();
  const projects = useProjects();
  const { relocateThread } = useThreadActions();
  const [query, setQuery] = useState("");
  const [selectedParentId, setSelectedParentId] = useState<ThreadId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const projectsByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const targetByKey = new Map(
    allThreads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
  const resolvedTargets = props.targets.flatMap((ref) => {
    const found = targetByKey.get(`${ref.environmentId}:${ref.threadId}`);
    return found && canRelocateThread(found) ? [found] : [];
  });

  const candidates = rankRelocationParentCandidates({
    targets: resolvedTargets,
    allThreads,
    projectsByKey,
    query,
  });

  const effectiveSelectedId =
    selectedParentId !== null &&
    candidates.some((candidate) => candidate.thread.id === selectedParentId)
      ? selectedParentId
      : (candidates.find((candidate) => !candidate.isCurrentParent)?.thread.id ??
        candidates[0]?.thread.id ??
        null);

  const selectedCandidate =
    candidates.find((candidate) => candidate.thread.id === effectiveSelectedId) ?? null;

  const canMoveToTopLevel = resolvedTargets.some(canMoveThreadToTopLevel);

  const runRelocation = async (parentThreadId: ThreadId | null, parentTitle: string | null) => {
    if (submitting || resolvedTargets.length === 0) return;
    setSubmitting(true);
    setErrorMessage(null);
    const failures: Array<unknown> = [];
    let succeeded = 0;
    for (const target of resolvedTargets) {
      const result = await relocateThread(
        { environmentId: target.environmentId, threadId: target.id },
        parentThreadId,
      );
      if (result._tag === "Success") {
        succeeded += 1;
      } else if (!isAtomCommandInterrupted(result)) {
        failures.push(squashAtomCommandFailure(result));
      }
    }
    setSubmitting(false);

    if (failures.length > 0) {
      const description = thrownErrorMessage(failures[0], m) ?? "Could not relocate thread.";
      setErrorMessage(description);
      if (succeeded > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title:
              succeeded === 1
                ? "Moved 1 chat, some failed"
                : `Moved ${succeeded} chats, some failed`,
            description,
          }),
        );
      }
      return;
    }

    if (succeeded > 0) {
      toastManager.add({
        type: "success",
        title:
          parentThreadId === null
            ? succeeded === 1
              ? "Moved to top level"
              : `Moved ${succeeded} chats to top level`
            : succeeded === 1
              ? `Moved under "${parentTitle ?? "parent"}"`
              : `Moved ${succeeded} chats under "${parentTitle ?? "parent"}"`,
      });
    }
    props.onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (candidates.length === 0) return;
    const currentIndex = candidates.findIndex(
      (candidate) => candidate.thread.id === effectiveSelectedId,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % candidates.length;
      setSelectedParentId(candidates[nextIndex]!.thread.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIndex = currentIndex <= 0 ? candidates.length - 1 : currentIndex - 1;
      setSelectedParentId(candidates[prevIndex]!.thread.id);
    } else if (event.key === "Enter" && selectedCandidate && !selectedCandidate.isCurrentParent) {
      event.preventDefault();
      void runRelocation(selectedCandidate.thread.id, selectedCandidate.thread.title);
    }
  };

  const title =
    resolvedTargets.length > 1
      ? `Move ${resolvedTargets.length} chats under parent`
      : "Move under parent";
  const description =
    resolvedTargets.length === 1
      ? `Choose a parent chat to nest "${resolvedTargets[0]!.title}" under as a sub-agent.`
      : `Choose a parent chat to nest these ${resolvedTargets.length} chats under as sub-agents.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search chats by title, project, or branch..."
                  aria-label="Search parent chats"
                  disabled={submitting}
                />
              </div>
            </div>

            <div
              role="listbox"
              aria-label="Parent chats"
              className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border/70 p-1"
            >
              {candidates.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {query.trim().length > 0
                    ? "No matching chats found."
                    : "No eligible parent chats in this environment."}
                </div>
              ) : (
                candidates.map((candidate) => {
                  const isSelected = candidate.thread.id === effectiveSelectedId;
                  const projectName = candidate.project?.isScratch
                    ? "No project"
                    : candidate.project?.title;
                  return (
                    <button
                      key={candidate.thread.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={submitting}
                      onClick={() => setSelectedParentId(candidate.thread.id)}
                      onDoubleClick={() => {
                        if (!candidate.isCurrentParent) {
                          void runRelocation(candidate.thread.id, candidate.thread.title);
                        }
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                      )}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {candidate.project ? (
                          <ProjectFavicon project={candidate.project} className="size-3.5" />
                        ) : (
                          <BotIcon className="size-3.5 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-tight">
                          {candidate.thread.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                          {projectName ? <span className="truncate">{projectName}</span> : null}
                          {projectName && candidate.thread.branch ? (
                            <span aria-hidden>·</span>
                          ) : null}
                          {candidate.thread.branch ? (
                            <span className="truncate font-mono">{candidate.thread.branch}</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {candidate.isCurrentParent ? (
                          <Badge variant="outline" size="sm">
                            Current
                          </Badge>
                        ) : null}
                        {candidate.isSubagent ? (
                          <Badge variant="outline" size="sm">
                            Sub-agent
                          </Badge>
                        ) : null}
                        {candidate.isSettled ? (
                          <Badge variant="outline" size="sm">
                            Settled
                          </Badge>
                        ) : null}
                        {isSelected ? (
                          <CheckIcon aria-hidden className="size-3.5 text-foreground" />
                        ) : null}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            {errorMessage ? (
              <p role="alert" className="text-xs text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter className="justify-between">
          <div>
            {canMoveToTopLevel ? (
              <Button
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => void runRelocation(null, null)}
              >
                <CornerLeftUpIcon className="size-3.5" />
                Move to top level
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={submitting} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                submitting ||
                selectedCandidate === null ||
                selectedCandidate.isCurrentParent ||
                resolvedTargets.length === 0
              }
              onClick={() => {
                if (selectedCandidate) {
                  void runRelocation(selectedCandidate.thread.id, selectedCandidate.thread.title);
                }
              }}
            >
              {submitting ? <Spinner size="xs" /> : <CornerDownRightIcon className="size-3.5" />}
              Move as sub-agent
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
