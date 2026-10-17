import * as Schema from "effect/Schema";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import {
  type OrganizingIconOverride,
  ProjectMonogramText,
  type ProjectIconColor,
} from "@t3tools/contracts";
import { createElement, useEffect, useRef, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "../../projectIconOptions";
import { cn } from "~/lib/utils";
import { lucideIconByName } from "../../lib/lucideIconByName";
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
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { createOrganizingIconImage, organizingIconImageError } from "../../organizingIconImage";

const DEFAULT_ICON = "folder-code";
const isMonogramText = Schema.is(ProjectMonogramText);

function PickerIcon({ name }: { name: string }) {
  const icon = lucideIconByName(name);
  return icon ? createElement(icon, { className: "size-5" }) : null;
}

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  current,
  projectName,
  entityType = "project",
  defaultIcon = DEFAULT_ICON,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: OrganizingIconOverride | null;
  readonly projectName: string;
  readonly entityType?: "project" | "board" | "folder";
  readonly defaultIcon?: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: OrganizingIconOverride) => void;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const [mode, setMode] = useState<OrganizingIconOverride["kind"]>(current?.kind ?? "lucide");
  const [iconName, setIconName] = useState<string>(
    current?.kind === "lucide" ? current.name : defaultIcon,
  );
  const [color, setColor] = useState<ProjectIconColor>(
    current && current.kind !== "emoji" && current.kind !== "image"
      ? current.color
      : automatic.color,
  );
  const [letters, setLetters] = useState(
    current?.kind === "monogram" ? current.text : automatic.monogram,
  );
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(
    current?.kind === "image" ? current.dataUrl : "",
  );
  const [imageError, setImageError] = useState<string | null>(null);
  const [readingImage, setReadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(current?.kind ?? "lucide");
      setIconName(current?.kind === "lucide" ? current.name : defaultIcon);
      setColor(
        current && current.kind !== "emoji" && current.kind !== "image"
          ? current.color
          : automatic.color,
      );
      setLetters(current?.kind === "monogram" ? current.text : automatic.monogram);
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
      setImageDataUrl(current?.kind === "image" ? current.dataUrl : "");
      setImageError(null);
      setReadingImage(false);
    }
    previousOpenRef.current = open;
  }, [current, open, automatic.color, automatic.monogram, defaultIcon]);

  const icons = filterProjectIconNames(query);
  const selectedColorClassName = projectIconColorClassName(color);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram = isMonogramText(monogram);
  const save = () => {
    if (mode === "monogram" && !validMonogram) return;
    if (mode === "image" && imageDataUrl.length === 0) return;
    onSelect(
      mode === "image"
        ? { kind: "image", dataUrl: imageDataUrl }
        : mode === "monogram"
          ? { kind: "monogram", text: monogram, color }
          : mode === "lucide"
            ? { kind: "lucide", name: iconName, color }
            : { kind: "emoji", emoji },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Choose {entityType} icon</DialogTitle>
          <DialogDescription>
            {entityType === "project"
              ? "Choose an icon, emoji, or monogram."
              : "Choose an icon, image, emoji, or monogram."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col">
          <ToggleGroup
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (
                value === "lucide" ||
                value === "image" ||
                value === "emoji" ||
                value === "monogram"
              )
                setMode(value);
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            {entityType === "board" || entityType === "folder" ? (
              <Toggle value="image">Image</Toggle>
            ) : null}
            <Toggle value="emoji">Emoji</Toggle>
            <Toggle value="monogram">Monogram</Toggle>
          </ToggleGroup>

          {mode !== "emoji" && mode !== "image" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === option.value}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      color === option.value && "border-foreground/64",
                    )}
                    onClick={() => setColor(option.value)}
                  >
                    <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "lucide" ? (
            <>
              <Input
                type="search"
                value={query}
                aria-label="Search Lucide icons"
                placeholder="Search all Lucide icons"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {icons.map((name) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={iconLabel(name)}
                      aria-pressed={iconName === name}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        iconName === name && "border-border bg-accent",
                        selectedColorClassName,
                      )}
                      onClick={() => setIconName(name)}
                    >
                      <PickerIcon name={name} />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {icons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
          ) : mode === "monogram" ? (
            <div className="flex items-center gap-4 py-2">
              <ProjectMonogram
                text={validMonogram ? monogram : automatic.monogram}
                color={color}
                className="size-12"
              />
              <div className="flex-1 space-y-2">
                <label htmlFor="project-monogram" className="text-sm font-medium">
                  Letters
                </label>
                <Input
                  id="project-monogram"
                  value={letters}
                  onChange={(event) => setLetters(event.currentTarget.value)}
                  aria-describedby="project-monogram-hint"
                  aria-invalid={!validMonogram}
                  autoComplete="off"
                />
                <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                  One or two letters or numbers.
                </p>
              </div>
            </div>
          ) : mode === "image" ? (
            <div className="flex flex-col items-center gap-3 py-2">
              {imageDataUrl ? (
                <img
                  src={imageDataUrl}
                  alt=""
                  className="size-20 rounded-xl border border-border object-contain"
                />
              ) : (
                <div className="flex size-20 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                  No image
                </div>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  setReadingImage(true);
                  setImageError(null);
                  void createOrganizingIconImage(file).then((result) => {
                    setReadingImage(false);
                    if (result.ok) {
                      setImageDataUrl(result.dataUrl);
                      return;
                    }
                    setImageError(organizingIconImageError(result.reason));
                  });
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={readingImage}
                onClick={() => imageInputRef.current?.click()}
              >
                {readingImage
                  ? "Preparing image…"
                  : imageDataUrl
                    ? "Replace image"
                    : "Choose image"}
              </Button>
              {imageError ? <p className="text-xs text-destructive">{imageError}</p> : null}
              <p className="text-center text-xs text-muted-foreground">
                T3 Code stores a small local copy for this {entityType}.
              </p>
            </div>
          ) : (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={emoji === option.emoji}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        emoji === option.emoji && "border-border bg-accent",
                      )}
                      onClick={() => setEmoji(option.emoji)}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Or paste any emoji
                </div>
                <Input
                  value={customEmoji}
                  aria-label="Custom emoji"
                  placeholder="Paste an emoji"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomEmoji(value);
                    const nextEmoji = firstEmoji(value);
                    if (nextEmoji) setEmoji(nextEmoji);
                  }}
                />
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              (mode === "monogram" && !validMonogram) ||
              (mode === "image" && (imageDataUrl.length === 0 || readingImage))
            }
          >
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
