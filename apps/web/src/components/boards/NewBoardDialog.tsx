import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { BoardTemplate } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import { useBoardTemplates, useTemplatesDispatch } from "../../state/templates";
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
import { RadioGroup } from "../ui/radio-group";
import { BOARD_KEY_PATTERN, suggestBoardKey } from "./boards.logic";

const DEFAULT_TEMPLATE_ID = "builtin:basic";

/** Names a new board and its ticket key prefix, picks a template, then opens it. */
export function NewBoardDialog({
  open,
  onOpenChange,
  takenKeys,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly takenKeys: ReadonlySet<string>;
}) {
  const dispatch = useTemplatesDispatch();
  const templates = useBoardTemplates();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState(DEFAULT_TEMPLATE_ID);
  // A deleted template falls back to the default.
  const templateId = templates.some((template) => template.id === picked)
    ? picked
    : DEFAULT_TEMPLATE_ID;
  // Follows the name until the key is edited by hand.
  const [customKey, setCustomKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const key = customKey ?? (name.trim() ? suggestBoardKey(name, takenKeys) : "");
  const keyTaken = takenKeys.has(key);
  const valid = name.trim().length > 0 && BOARD_KEY_PATTERN.test(key) && !keyTaken;

  const removeTemplate = async (template: BoardTemplate) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        `Delete template "${template.name}"?\nBoards made from it keep their columns and automations.`,
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    void dispatch({ type: "template.delete", templateId: template.id });
  };

  const reset = () => {
    setName("");
    setCustomKey(null);
    setPicked(DEFAULT_TEMPLATE_ID);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    const id = await dispatch({ type: "board.create", templateId, name: name.trim(), key });
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
            {templates.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span id="new-board-template" className="text-sm font-medium">
                  Template
                </span>
                <RadioGroup
                  value={templateId}
                  onValueChange={(value) => setPicked(String(value))}
                  aria-labelledby="new-board-template"
                >
                  {templates.map((template) => (
                    <div key={template.id} className="flex items-start gap-1">
                      <RadioPrimitive.Root
                        value={template.id}
                        className={cn(
                          "flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors",
                          "focus-visible:ring-2 focus-visible:ring-ring",
                          template.id === templateId
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className="text-sm font-medium">{template.name}</span>
                        {template.description ? (
                          <span className="text-xs text-muted-foreground">
                            {template.description}
                          </span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {template.columns.map((column) => column.name).join(" → ")}
                          {template.automations.length > 0
                            ? ` · ${template.automations.length} automation${template.automations.length === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      </RadioPrimitive.Root>
                      {template.builtIn ? null : (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Delete template ${template.name}`}
                          onClick={() => void removeTemplate(template)}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </div>
                  ))}
                </RadioGroup>
              </div>
            ) : null}
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
