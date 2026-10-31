import type { OrganizingIconOverride } from "@t3tools/contracts";
import { SquareKanbanIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "../lib/utils";
import { ProjectMonogram } from "./ProjectMonogram";

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

/** A board's custom identity with a small type badge so boards stay recognizable. */
export function OrganizingIcon({
  icon,
  className,
}: {
  readonly icon?: OrganizingIconOverride | null | undefined;
  readonly className?: string;
}) {
  const TypeIcon = SquareKanbanIcon;
  if (!icon) {
    return <TypeIcon aria-hidden className={cn("size-4 shrink-0 text-icon-muted", className)} />;
  }
  return (
    <span aria-hidden className={cn("relative inline-flex size-4 shrink-0 text-base", className)}>
      {icon.kind === "image" ? (
        <img src={icon.dataUrl} alt="" className="size-full rounded-[25%] object-contain" />
      ) : icon.kind === "monogram" ? (
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
