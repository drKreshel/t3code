import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

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
import { BOARD_KEY_PATTERN, suggestBoardKey } from "./boards.logic";

/** Names a new board and its ticket key prefix, then opens it. */
export function NewBoardDialog({
  open,
  onOpenChange,
  takenKeys,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly takenKeys: ReadonlySet<string>;
}) {
  const dispatch = useBoardsDispatch();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  // Follows the name until the key is edited by hand.
  const [customKey, setCustomKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const key = customKey ?? (name.trim() ? suggestBoardKey(name, takenKeys) : "");
  const keyTaken = takenKeys.has(key);
  const valid = name.trim().length > 0 && BOARD_KEY_PATTERN.test(key) && !keyTaken;

  const reset = () => {
    setName("");
    setCustomKey(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    const id = await dispatch({ type: "board.create", name: name.trim(), key });
    setSubmitting(false);
    if (id === undefined) return;
    onOpenChange(false);
    reset();
    void navigate({ to: "/boards/$boardKey", params: { boardKey: key } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>New board</DialogTitle>
            <DialogDescription>
              Tickets on this board are numbered with its key, like {key || "WEB"}-1.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-board-name">Name</Label>
              <Input
                id="new-board-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Web app"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-board-key">Key</Label>
              <Input
                id="new-board-key"
                value={key}
                maxLength={5}
                onChange={(event) =>
                  setCustomKey(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                placeholder="WEB"
              />
              <p className="text-xs text-muted-foreground">
                {keyTaken
                  ? `${key} is used by another board.`
                  : "2 to 5 capital letters or digits, starting with a letter."}
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              Create board
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
