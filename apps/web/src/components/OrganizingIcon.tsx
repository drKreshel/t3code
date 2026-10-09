import type { ProjectIconOverride } from "@t3tools/contracts";
import { FolderIcon, FolderOpenIcon, SquareKanbanIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "../lib/utils";
import { ProjectMonogram } from "./ProjectMonogram";

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

/** Custom identity with a small type badge so folders and boards stay recognizable. */
export function OrganizingIcon({
  icon,
  kind,
  expanded = false,
  className,
}: {
  readonly icon?: ProjectIconOverride | null | undefined;
  readonly kind: "board" | "folder";
  readonly expanded?: boolean;
  readonly className?: string;
}) {
  const TypeIcon = kind === "board" ? SquareKanbanIcon : expanded ? FolderOpenIcon : FolderIcon;
  if (!icon) {
    return <TypeIcon aria-hidden className={cn("size-4 shrink-0 text-icon-muted", className)} />;
  }
  return (
    <span aria-hidden className={cn("relative inline-flex size-4 shrink-0 text-base", className)}>
      {icon.kind === "monogram" ? (
        <ProjectMonogram text={icon.text} color={icon.color} className="size-full" />
      ) : icon.kind === "emoji" ? (
        <span className="flex size-full items-center justify-center leading-none">
          <span className="leading-none">{icon.emoji}</span>
        </span>
      ) : (
        <Suspense fallback={<TypeIcon className="size-full" />}>
          <DynamicIcon
            name={icon.name as IconName}
            className={cn("size-full", projectIconColorClassName(icon.color))}
          />
        </Suspense>
      )}
      <span className="absolute -right-1 -bottom-0.5 flex size-2.5 items-center justify-center rounded-xs bg-sidebar text-sidebar-foreground ring-1 ring-sidebar">
        <TypeIcon className="size-2" strokeWidth={2.5} />
      </span>
    </span>
  );
}
