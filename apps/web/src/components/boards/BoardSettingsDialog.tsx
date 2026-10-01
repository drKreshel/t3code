import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { Board, BoardColumn } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { useBoardsDispatch } from "../../state/boards";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useBoardTemplates, useTemplatesDispatch } from "../../state/templates";
import { rulesOf, useWorkspaces } from "../../state/workspaces";
import { BOARD_KEY_PATTERN, positionBetween } from "./boards.logic";
import { WorkspaceRulesEditor } from "./WorkspaceSettings";
import {
  COLUMN_COLOR_LABEL,
  COLUMN_COLORS,
  columnDotClass,
  type ColumnColor,
} from "./boardsPresentation";
import { cn } from "../../lib/utils";

const NO_COLOR = "none";

/** Renames a board, changes its key, and edits its columns. */
export function BoardSettingsDialog({
  board,
  open,
  onOpenChange,
}: {
  readonly board: Board;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription>
            Columns are just names. What happens when a ticket enters one comes from automations
            (the ⚡ on each column).
          </DialogDescription>
        </DialogHeader>
        {/* Remount on open so the fields start from the board's current values. */}
        {open ? <BoardSettingsFields board={board} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function BoardSettingsFields({ board }: { readonly board: Board }) {
  const dispatch = useBoardsDispatch();
  const [name, setName] = useState(board.name);
  const [key, setKey] = useState(board.key);
  const columns = board.columns.toSorted((a, b) => a.position - b.position);

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === board.name) return;
    void dispatch({ type: "board.update", boardId: board.id, name: trimmed });
  };
  const saveKey = async () => {
    if (key === board.key) return;
    if (!BOARD_KEY_PATTERN.test(key)) {
      setKey(board.key);
      return;
    }
    // A refused key (taken) toasts; show the key that stuck.
    if ((await dispatch({ type: "board.update", boardId: board.id, key })) === undefined) {
      setKey(board.key);
    }
  };
  const move = (column: BoardColumn, offset: -1 | 1) => {
    const index = columns.indexOf(column);
    const target = index + offset;
    if (target < 0 || target >= columns.length) return;
    // Land between the neighbour being passed and the one beyond it.
    const beyond = columns[target + offset];
    const position =
      offset === -1
        ? positionBetween(beyond?.position, columns[target]!.position)
        : positionBetween(columns[target]!.position, beyond?.position);
    void dispatch({ type: "column.reorder", columnId: column.id, position });
  };
  const remove = async (column: BoardColumn) => {
    const fallback = columns.find((candidate) => candidate.id !== column.id);
    if (!fallback) return;
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        `Delete column "${column.name}"?\nIts tickets move to "${fallback.name}".`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    void dispatch({ type: "column.delete", columnId: column.id, moveTicketsTo: fallback.id });
  };

  return (
    <DialogPanel>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <div className="flex flex-col gap-2">
          <Label htmlFor="board-settings-name">Name</Label>
          <Input
            id="board-settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="board-settings-key">Key</Label>
          <Input
            id="board-settings-key"
            value={key}
            maxLength={5}
            onChange={(event) => setKey(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            onBlur={() => void saveKey()}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Changing the key renumbers nothing: tickets keep their numbers under the new key.
      </p>
      <div className="flex flex-col gap-2">
        <Label>Columns</Label>
        <ul className="flex flex-col gap-1.5">
          {columns.map((column, index) => (
            <ColumnRow
              key={column.id}
              column={column}
              first={index === 0}
              last={index === columns.length - 1}
              onlyColumn={columns.length === 1}
              onMove={(offset) => move(column, offset)}
              onRemove={() => void remove(column)}
            />
          ))}
        </ul>
        <Button
          className="self-start"
          size="xs"
          variant="ghost"
          onClick={() =>
            void dispatch({
              type: "column.create",
              boardId: board.id,
              name: "New column",
            })
          }
        >
          <PlusIcon />
          Add column
        </Button>
      </div>
      <BoardWorkspaceSettings board={board} />
      <SaveAsTemplate board={board} />
    </DialogPanel>
  );
}

/** Saves the board's columns and its own automations for new boards to start from. */
function SaveAsTemplate({ board }: { readonly board: Board }) {
  const dispatch = useTemplatesDispatch();
  const templates = useBoardTemplates();
  const [name, setName] = useState(board.name);
  const [saved, setSaved] = useState<string | null>(null);
  const trimmed = name.trim();
  const replaces = templates.some((template) => !template.builtIn && template.name === trimmed);
  const save = async () => {
    if (!trimmed) return;
    const id = await dispatch({ type: "template.save", boardId: board.id, name: trimmed });
    if (id) setSaved(trimmed);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="board-settings-template">Save as template</Label>
        <p className="text-xs text-muted-foreground">
          New boards can start from it: these columns, this board's column automations, and the
          schedules that move its old tickets. Hooks use each new board's own project.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id="board-settings-template"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(null);
          }}
        />
        <Button size="sm" variant="outline" disabled={!trimmed} onClick={() => void save()}>
          {replaces ? "Replace" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {saved === trimmed && saved !== null
          ? `Saved. Pick "${saved}" when creating a board.`
          : replaces
            ? `Replaces your template "${trimmed}".`
            : "Delete templates from the New board dialog."}
      </p>
    </div>
  );
}

/**
 * Which repos this board's tickets work in, how, and from which branch. The
 * project's settings apply to every board using the project; the board's
 * override them; a ticket can override both.
 */
function BoardWorkspaceSettings({ board }: { readonly board: Board }) {
  const snapshot = useWorkspaces();
  const projectKey = board.defaultProjectKey;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label>Ticket workspaces</Label>
        <p className="text-xs text-muted-foreground">
          Each ticket's chats run in its own folder, with a git worktree per repo on the branch
          ticket/&lt;key&gt;. "Inherit" takes the setting from the level above: a ticket from its
          board, a board from the project, and the project from the default (a worktree for a single
          repo, nothing for a folder of repos).
        </p>
      </div>
      {projectKey === null ? (
        <p className="text-sm text-muted-foreground">
          Set the board's default project to choose its workspace settings.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">This board</span>
            <WorkspaceRulesEditor
              scope="board"
              scopeId={board.id}
              projectKey={projectKey}
              earlierLayers={[rulesOf(snapshot, "project", projectKey)]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Every board using this project
            </span>
            <WorkspaceRulesEditor
              scope="project"
              scopeId={projectKey}
              projectKey={projectKey}
              earlierLayers={[]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ColumnRow({
  column,
  first,
  last,
  onlyColumn,
  onMove,
  onRemove,
}: {
  readonly column: BoardColumn;
  readonly first: boolean;
  readonly last: boolean;
  readonly onlyColumn: boolean;
  readonly onMove: (offset: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const dispatch = useBoardsDispatch();
  const [name, setName] = useState(column.name);
  return (
    <li className="flex items-center gap-1.5">
      <Input
        size="sm"
        aria-label="Column name"
        className="min-w-0 flex-1"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const trimmed = name.trim();
          if (!trimmed) setName(column.name);
          else if (trimmed !== column.name) {
            void dispatch({ type: "column.update", columnId: column.id, name: trimmed });
          }
        }}
      />
      <Select
        value={column.color ?? NO_COLOR}
        onValueChange={(value) =>
          void dispatch({
            type: "column.update",
            columnId: column.id,
            color: value === NO_COLOR ? null : String(value),
          })
        }
      >
        <SelectTrigger size="sm" className="w-28" aria-label="Column color">
          <SelectValue>
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", columnDotClass(column.color))} />
              {column.color
                ? (COLUMN_COLOR_LABEL[column.color as ColumnColor] ?? column.color)
                : "None"}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value={NO_COLOR}>
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", columnDotClass(null))} />
              None
            </span>
          </SelectItem>
          {COLUMN_COLORS.map((color) => (
            <SelectItem key={color} value={color}>
              <span className="flex items-center gap-2">
                <span className={cn("size-2 rounded-full", columnDotClass(color))} />
                {COLUMN_COLOR_LABEL[color]}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        aria-label="Move column left"
        size="icon-xs"
        variant="ghost"
        disabled={first}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        aria-label="Move column right"
        size="icon-xs"
        variant="ghost"
        disabled={last}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon />
      </Button>
      <Button
        aria-label="Delete column"
        size="icon-xs"
        variant="ghost"
        disabled={onlyColumn}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}
