import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { TicketComment, TicketEvent, TicketPriority, TicketStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  LockIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useAutomations, useAutomationsDispatch } from "../../state/automations";
import { useBoardsDispatch, useTicketDetail } from "../../state/boards";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { TicketWorkspaceSection } from "./WorkspaceSettings";
import { describeTicketEvent } from "./boards.logic";
import { BoardsPageFrame, BoardsStatusMessage } from "./BoardsPageFrame";
import { columnDotClass, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL } from "./boardsPresentation";
import { useBoardsModel, type TicketView } from "./useBoardsModel";
import { pickProjectKey, useProjectLookup, useStartTicketSession } from "./useTicketActions";

/** A ticket's details, criteria, requirements, chats, comments, and timeline. */
export function TicketPage({
  boardKey,
  ticketNumber,
}: {
  readonly boardKey: string;
  readonly ticketNumber: number;
}) {
  const model = useBoardsModel();
  const board = model.status === "ready" ? model.index.boardByKey.get(boardKey) : undefined;
  const view =
    model.status === "ready" && board
      ? [...model.viewById.values()].find(
          (candidate) =>
            candidate.board.id === board.id && candidate.ticket.number === ticketNumber,
        )
      : undefined;
  const label = `${boardKey}-${ticketNumber}`;
  if (model.status !== "ready" || !board || !view) {
    return (
      <BoardsPageFrame
        crumbs={[board ? { label: board.name, to: { boardKey } } : { label: boardKey }, { label }]}
      >
        <BoardsStatusMessage>
          {model.status === "loading"
            ? "Loading ticket…"
            : model.status === "unavailable"
              ? "Boards are unavailable. They need this computer's own server to be running."
              : `There is no ticket ${label}.`}
        </BoardsStatusMessage>
      </BoardsPageFrame>
    );
  }
  return (
    <BoardsPageFrame crumbs={[{ label: board.name, to: { boardKey } }, { label: view.label }]}>
      <TicketBody view={view} viewById={model.viewById} />
    </BoardsPageFrame>
  );
}

function TicketBody({
  view,
  viewById,
}: {
  readonly view: TicketView;
  readonly viewById: ReadonlyMap<string, TicketView>;
}) {
  const detail = useTicketDetail(view.ticket.id);
  const comments = detail?.comments ?? [];
  const handoff = comments.toReversed().find((comment) => comment.isHandoff) ?? null;
  const readOnly = view.board.archivedAt !== null || view.ticket.archivedAt !== null;
  return (
    <WorkspacePageContainer width="expanded">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <TicketHeading view={view} readOnly={readOnly} />
          {view.attention ? <TicketAttentionBanner view={view} readOnly={readOnly} /> : null}
          {view.blockers.length > 0 ? (
            <p className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              <LockIcon className="size-3.5 shrink-0" />
              Waiting on {view.blockerLabels.join(", ")}.
            </p>
          ) : null}
          {handoff ? (
            <section className="flex flex-col gap-1.5 rounded-lg border border-border/60 px-3 py-2">
              <h2 className="text-xs font-medium text-muted-foreground">Latest handoff</h2>
              <ChatMarkdown text={handoff.body} cwd={undefined} isStreaming={false} />
            </section>
          ) : null}
          <DescriptionSection view={view} readOnly={readOnly} />
          <CriteriaSection view={view} readOnly={readOnly} />
          <SessionsSection view={view} readOnly={readOnly} />
          <TicketWorkspaceSection
            ticketId={view.ticket.id}
            boardId={view.board.id}
            projectKey={view.ticket.projectKey ?? view.board.defaultProjectKey}
            readOnly={readOnly}
          />
          <TicketRunsSection view={view} readOnly={readOnly} />
          <CommentsSection
            view={view}
            comments={comments}
            loading={detail === null}
            readOnly={readOnly}
          />
          <TimelineSection events={detail?.events ?? []} />
        </div>
        <TicketProperties view={view} viewById={viewById} readOnly={readOnly} />
      </div>
    </WorkspacePageContainer>
  );
}

function TicketHeading({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const [title, setTitle] = useState<string | null>(null);
  if (title === null || readOnly) {
    return (
      <h2
        className={cn("text-xl font-semibold text-foreground", !readOnly && "cursor-text")}
        onClick={() => {
          if (!readOnly) setTitle(view.ticket.title);
        }}
      >
        {view.ticket.title}
      </h2>
    );
  }
  const save = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== view.ticket.title) {
      void dispatch({ type: "ticket.update", ticketId: view.ticket.id, title: trimmed });
    }
    setTitle(null);
  };
  return (
    <Input
      autoFocus
      aria-label="Ticket title"
      size="lg"
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        else if (event.key === "Escape") setTitle(null);
      }}
    />
  );
}

function SectionHeading({
  children,
  actions,
}: {
  readonly children: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-medium text-foreground">{children}</h2>
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </div>
  );
}

function DescriptionSection({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const [draft, setDraft] = useState<string | null>(null);
  const description = view.ticket.description;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        actions={
          !readOnly && draft === null ? (
            <Button size="xs" variant="ghost" onClick={() => setDraft(description)}>
              Edit
            </Button>
          ) : null
        }
      >
        Description
      </SectionHeading>
      {draft !== null ? (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            aria-label="Description"
            rows={8}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={() => {
                void dispatch({
                  type: "ticket.update",
                  ticketId: view.ticket.id,
                  description: draft,
                });
                setDraft(null);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : description.trim() ? (
        <ChatMarkdown text={description} cwd={undefined} isStreaming={false} />
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
    </section>
  );
}

function CriteriaSection({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const [text, setText] = useState("");
  const criteria = view.ticket.criteria.toSorted((a, b) => a.position - b.position);
  const checked = criteria.filter((criterion) => criterion.checked).length;
  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    void dispatch({ type: "criterion.add", ticketId: view.ticket.id, text: trimmed });
  };
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        actions={
          criteria.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {checked}/{criteria.length}
            </span>
          ) : null
        }
      >
        Acceptance criteria
      </SectionHeading>
      {criteria.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {criteria.map((criterion) => (
            <li key={criterion.id} className="group/criterion flex items-center gap-2 text-sm">
              <Checkbox
                aria-label={criterion.text}
                checked={criterion.checked}
                disabled={readOnly}
                onCheckedChange={(next) =>
                  void dispatch({
                    type: "criterion.update",
                    criterionId: criterion.id,
                    checked: next === true,
                  })
                }
              />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  criterion.checked && "text-muted-foreground line-through",
                )}
              >
                {criterion.text}
              </span>
              {!readOnly ? (
                <span className="opacity-0 group-hover/criterion:opacity-100 focus-within:opacity-100">
                  <Button
                    aria-label="Remove criterion"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      void dispatch({ type: "criterion.delete", criterionId: criterion.id })
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!readOnly ? (
        <Input
          size="sm"
          aria-label="New criterion"
          placeholder="Add a criterion, then Enter"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      ) : null}
    </section>
  );
}

function SessionsSection({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const startSession = useStartTicketSession();
  const knownKeys = new Set(view.threads.map((thread) => threadKeyOf(thread)));
  const unknownCount = view.ticket.threadKeys.filter((key) => !knownKeys.has(key)).length;
  const handleStart = (event: MouseEvent) => {
    void startSession(view, { pickProject: event.shiftKey || event.altKey });
  };
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        actions={
          !readOnly ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="xs" variant="outline" onClick={handleStart}>
                    <MessageSquarePlusIcon />
                    Start session
                  </Button>
                }
              />
              <TooltipPopup side="top">Shift-click to pick another project</TooltipPopup>
            </Tooltip>
          ) : null
        }
      >
        Sessions
      </SectionHeading>
      {view.threads.length === 0 && unknownCount === 0 ? (
        <p className="text-sm text-muted-foreground">No chats yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
          {view.threads.map((thread) => {
            const status = resolveThreadStatusPill({ thread });
            const threadKey = threadKeyOf(thread);
            return (
              <li
                key={threadKey}
                className="group/session flex items-center gap-2 px-3 py-2 text-sm"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    status?.dotClass ?? "bg-muted-foreground/30",
                  )}
                />
                <Link
                  className="min-w-0 truncate hover:underline"
                  to="/$environmentId/$threadId"
                  params={{ environmentId: thread.environmentId, threadId: thread.id }}
                >
                  {thread.title}
                </Link>
                {status ? (
                  <span className={cn("shrink-0 text-xs", status.colorClass)}>{status.label}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(thread.updatedAt)}
                </span>
                {!readOnly ? (
                  <span className="opacity-0 group-hover/session:opacity-100 focus-within:opacity-100">
                    <Button
                      aria-label="Unlink chat"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        void dispatch({ type: "thread.link", threadKey, ticketId: null })
                      }
                    >
                      <UnlinkIcon />
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
          {unknownCount > 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {unknownCount} chat{unknownCount === 1 ? "" : "s"} not started yet, archived, or on an
              environment that is not connected
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function threadKeyOf(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function commentAuthorLabel(author: string, threadTitleByKey: ReadonlyMap<string, string>): string {
  if (author === "user") return "You";
  const threadKey = author.startsWith("thread:") ? author.slice("thread:".length) : null;
  if (threadKey === null) return author;
  const title = threadTitleByKey.get(threadKey);
  return title ? `Agent in "${title}"` : "Agent";
}

function CommentsSection({
  view,
  comments,
  loading,
  readOnly,
}: {
  readonly view: TicketView;
  readonly comments: ReadonlyArray<TicketComment>;
  readonly loading: boolean;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const [body, setBody] = useState("");
  const [isHandoff, setIsHandoff] = useState(false);
  const threadTitleByKey = new Map(
    view.threads.map((thread) => [threadKeyOf(thread), thread.title]),
  );
  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const id = await dispatch({
      type: "comment.add",
      ticketId: view.ticket.id,
      body: trimmed,
      ...(isHandoff ? { isHandoff } : {}),
    });
    if (id === undefined) return;
    setBody("");
    setIsHandoff(false);
  };
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Comments</SectionHeading>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : comments.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="group/comment flex flex-col gap-1 rounded-lg border border-border/60 px-3 py-2"
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {commentAuthorLabel(comment.author, threadTitleByKey)}
                </span>
                <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                {comment.isHandoff ? (
                  <Badge variant="info" size="sm">
                    Handoff
                  </Badge>
                ) : null}
                {!readOnly ? (
                  <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void dispatch({
                          type: "comment.update",
                          commentId: comment.id,
                          isHandoff: !comment.isHandoff,
                        })
                      }
                    >
                      {comment.isHandoff ? "Not a handoff" : "Mark as handoff"}
                    </Button>
                    <Button
                      aria-label="Delete comment"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        void dispatch({ type: "comment.delete", commentId: comment.id })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ) : null}
              </div>
              <ChatMarkdown text={comment.body} cwd={undefined} isStreaming={false} />
            </li>
          ))}
        </ul>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="New comment"
            placeholder="Write a comment"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={isHandoff}
                onCheckedChange={(next) => setIsHandoff(next === true)}
              />
              Handoff for the next session
            </label>
            <Button
              className="ml-auto"
              size="xs"
              disabled={!body.trim()}
              onClick={() => void submit()}
            >
              Comment
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TimelineSection({ events }: { readonly events: ReadonlyArray<TicketEvent> }) {
  if (events.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Timeline</SectionHeading>
      <ol className="flex flex-col gap-1.5 text-sm">
        {events.toReversed().map((event) => (
          <li key={event.id} className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 text-muted-foreground">
              <span className="text-foreground">{event.actor === "user" ? "You" : "Agent"}</span>{" "}
              {describeTicketEvent(event).replace(/^./, (first) => first.toLowerCase())}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTimeLabel(event.createdAt)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PropertyRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function TicketProperties({
  view,
  viewById,
  readOnly,
}: {
  readonly view: TicketView;
  readonly viewById: ReadonlyMap<string, TicketView>;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const lookupProject = useProjectLookup();
  const { ticket, board } = view;
  const columns = board.columns.toSorted((a, b) => a.position - b.position);
  const column = columns.find((candidate) => candidate.id === ticket.columnId);
  const ownProject = lookupProject(ticket.projectKey);
  const boardProject = lookupProject(board.defaultProjectKey);
  const required = ticket.requires.flatMap((id) => {
    const requiredView = viewById.get(id);
    return requiredView ? [requiredView] : [];
  });
  const candidates = [...viewById.values()]
    .filter(
      (candidate) =>
        candidate.ticket.id !== ticket.id &&
        candidate.ticket.archivedAt === null &&
        candidate.board.archivedAt === null &&
        !ticket.requires.includes(candidate.ticket.id),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const moveTo = (columnId: string) => {
    if (columnId === ticket.columnId) return;
    void dispatch({ type: "ticket.move", ticketId: ticket.id, columnId });
  };

  return (
    <aside className="flex flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
      <PropertyRow label="Status">
        <Select
          value={ticket.status}
          disabled={readOnly}
          onValueChange={(value) =>
            void dispatch({
              type: "ticket.setStatus",
              ticketId: ticket.id,
              status: value as TicketStatus,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Status">
            <SelectValue>{STATUS_LABEL[ticket.status]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {TICKET_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABEL[status]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </PropertyRow>
      <PropertyRow label="Column">
        <Select
          value={ticket.columnId}
          disabled={readOnly}
          onValueChange={(value) => moveTo(String(value))}
        >
          <SelectTrigger size="sm" aria-label="Column">
            <SelectValue>
              {column ? (
                <span className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", columnDotClass(column.color))} />
                  {column.name}
                </span>
              ) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {columns.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                <span className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", columnDotClass(candidate.color))} />
                  {candidate.name}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </PropertyRow>
      <PropertyRow label="Priority">
        <Select
          value={ticket.priority}
          disabled={readOnly}
          onValueChange={(value) =>
            void dispatch({
              type: "ticket.update",
              ticketId: ticket.id,
              priority: value as TicketPriority,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Priority">
            <SelectValue>{PRIORITY_LABEL[ticket.priority]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {PRIORITIES.map((priority) => (
              <SelectItem key={priority} value={priority}>
                {PRIORITY_LABEL[priority]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </PropertyRow>
      <PropertyRow label="Project">
        <Menu>
          <MenuTrigger
            disabled={readOnly}
            render={<Button className="justify-start" size="sm" variant="outline" />}
          >
            <FolderIcon />
            <span className="min-w-0 truncate">
              {ownProject?.title ??
                (boardProject ? `${boardProject.title} (board default)` : "Pick when starting")}
            </span>
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              onClick={() =>
                pickProjectKey(
                  (projectKey) =>
                    void dispatch({ type: "ticket.update", ticketId: ticket.id, projectKey }),
                )
              }
            >
              Choose project…
            </MenuItem>
            {ticket.projectKey !== null ? (
              <MenuItem
                onClick={() =>
                  void dispatch({ type: "ticket.update", ticketId: ticket.id, projectKey: null })
                }
              >
                Use the board default
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </PropertyRow>
      <PropertyRow label="Requires">
        {required.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {required.map((requiredView) => (
              <li
                key={requiredView.ticket.id}
                className="group/requires flex min-w-0 items-center gap-2 text-sm"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    requiredView.ticket.status === "done"
                      ? "bg-success"
                      : requiredView.ticket.status === "canceled"
                        ? "bg-muted-foreground/30"
                        : "bg-muted-foreground/70",
                  )}
                />
                <Link
                  className="min-w-0 truncate hover:underline"
                  to="/boards/$boardKey/$ticketNumber"
                  params={{
                    boardKey: requiredView.board.key,
                    ticketNumber: String(requiredView.ticket.number),
                  }}
                >
                  <span className="font-mono text-xs text-muted-foreground">
                    {requiredView.label}
                  </span>{" "}
                  {requiredView.ticket.title}
                </Link>
                {!readOnly ? (
                  <span className="ml-auto opacity-0 group-hover/requires:opacity-100 focus-within:opacity-100">
                    <Button
                      aria-label={`Remove requirement ${requiredView.label}`}
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        void dispatch({
                          type: "requirement.remove",
                          ticketId: ticket.id,
                          requiresTicketId: requiredView.ticket.id,
                        })
                      }
                    >
                      <XIcon />
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!readOnly && candidates.length > 0 ? (
          <Select
            value=""
            onValueChange={(value) => {
              if (typeof value !== "string" || !value) return;
              void dispatch({
                type: "requirement.add",
                ticketId: ticket.id,
                requiresTicketId: value,
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Add a required ticket">
              <SelectValue>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <PlusIcon className="size-3.5" />
                  Add required ticket
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.ticket.id} value={candidate.ticket.id}>
                  <span className="font-mono text-xs text-muted-foreground">{candidate.label}</span>{" "}
                  {candidate.ticket.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </PropertyRow>
      <PropertyRow label="Dates">
        <p className="text-xs text-muted-foreground">
          Created {formatRelativeTimeLabel(ticket.createdAt)}, updated{" "}
          {formatRelativeTimeLabel(ticket.updatedAt)}
        </p>
      </PropertyRow>
      {view.board.archivedAt === null ? (
        <Button
          className="self-start"
          size="xs"
          variant="ghost"
          onClick={() =>
            void dispatch({
              type: "ticket.archive",
              ticketId: ticket.id,
              archived: ticket.archivedAt === null,
            })
          }
        >
          {ticket.archivedAt === null ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
          {ticket.archivedAt === null ? "Archive ticket" : "Restore ticket"}
        </Button>
      ) : null}
    </aside>
  );
}

/** Automation runs on this ticket, and the way back from the run limit. */
function TicketRunsSection({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const automations = useAutomations();
  const dispatch = useAutomationsDispatch();
  if (automations.status !== "ready") return null;
  const runs = automations.snapshot.runs.filter((run) => run.ticketId === view.ticket.id);
  if (runs.length === 0) return null;
  const titleOf = (automationId: string) =>
    automations.snapshot.automations.find((automation) => automation.id === automationId)?.title ??
    "Deleted automation";
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading
        actions={
          !readOnly ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void dispatch({ type: "ticket.resumeHooks", ticketId: view.ticket.id })
                    }
                  >
                    <RotateCcwIcon />
                    Resume hooks
                  </Button>
                }
              />
              <TooltipPopup side="top">
                Resets the run limit and runs the hooks of its current column
              </TooltipPopup>
            </Tooltip>
          ) : null
        }
      >
        Automation runs
      </SectionHeading>
      <ol className="flex flex-col gap-1.5 text-sm">
        {runs.slice(0, 10).map((run) => {
          const threadRef = run.threadKey ? parseScopedThreadKey(run.threadKey) : null;
          return (
            <li key={run.id} className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-foreground">{titleOf(run.automationId)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {run.status} {formatRelativeTimeLabel(run.startedAt ?? run.createdAt)}
              </span>
              {threadRef ? (
                <Link
                  className="shrink-0 text-xs hover:underline"
                  to="/$environmentId/$threadId"
                  params={{ environmentId: threadRef.environmentId, threadId: threadRef.threadId }}
                >
                  Open chat
                </Link>
              ) : null}
              {run.reason ? (
                <span className="min-w-0 truncate text-xs text-muted-foreground">{run.reason}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const TICKET_STATUSES: ReadonlyArray<TicketStatus> = ["open", "done", "canceled"];

/**
 * What the ticket waits on, with the way out: Resolve clears a stored flag and
 * lets the ticket's held automations run. Chat waits clear themselves.
 */
function TicketAttentionBanner({
  view,
  readOnly,
}: {
  readonly view: TicketView;
  readonly readOnly: boolean;
}) {
  const dispatch = useBoardsDispatch();
  const attention = view.attention!;
  const error = attention.level === "error";
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm",
        error
          ? "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16"
          : "bg-warning/8 text-warning-foreground dark:bg-warning/16",
      )}
    >
      <span className="min-w-0 flex-1">
        {error ? "Error" : "Needs you"}: {attention.reason}
      </span>
      {attention.kind === "flag" && !readOnly ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => void dispatch({ type: "ticket.resolveFlag", ticketId: view.ticket.id })}
        >
          Resolve
        </Button>
      ) : null}
    </div>
  );
}
