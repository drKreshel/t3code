import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { Board, BoardColumn, BoardColumnType } from "@t3tools/contracts";
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
import { BOARD_KEY_PATTERN, positionBetween } from "./boards.logic";
import { COLUMN_TYPE_LABEL, COLUMN_TYPES } from "./boardsPresentation";

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
            Column types decide what a column means: blocked tickets cannot start, and Needs you
            columns count as waiting on you.
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
              columnType: "todo",
            })
          }
        >
          <PlusIcon />
          Add column
        </Button>
      </div>
    </DialogPanel>
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
        value={column.type}
        onValueChange={(value) =>
          void dispatch({
            type: "column.update",
            columnId: column.id,
            columnType: value as BoardColumnType,
          })
        }
      >
        <SelectTrigger size="sm" className="w-32" aria-label="Column type">
          <SelectValue>{COLUMN_TYPE_LABEL[column.type]}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {COLUMN_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {COLUMN_TYPE_LABEL[type]}
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
