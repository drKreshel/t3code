import type { ProjectIconOverride } from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";

import { OrganizingIcon } from "./OrganizingIcon";
import { Button } from "./ui/button";

const IconPicker = lazy(() =>
  import("./settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

export function OrganizingIconSetting({
  icon,
  kind,
  name,
  onSelect,
}: {
  readonly icon?: ProjectIconOverride | null | undefined;
  readonly kind: "board" | "folder";
  readonly name: string;
  readonly onSelect: (icon: ProjectIconOverride | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <OrganizingIcon icon={icon} kind={kind} className="mr-1 size-6 text-2xl" />
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Choose icon
      </Button>
      {icon ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => onSelect(null)}>
          Reset icon
        </Button>
      ) : null}
      {open ? (
        <Suspense fallback={null}>
          <IconPicker
            current={icon ?? null}
            projectName={name}
            entityType={kind}
            defaultIcon={kind === "board" ? "square-kanban" : "folder"}
            open={open}
            onOpenChange={setOpen}
            onSelect={onSelect}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
