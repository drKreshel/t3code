import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: ({ children }: { readonly children?: ReactNode }) => <button>{children}</button>,
}));

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("../ui/input", () => ({ Input: () => <input /> }));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) => (
    <button data-value={value}>{children}</button>
  ),
  ToggleGroup: ({
    children,
    value,
  }: {
    readonly children?: ReactNode;
    readonly value: readonly string[];
  }) => <div data-current={value.join(",")}>{children}</div>,
}));

import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

describe("ProjectIconPickerDialog", () => {
  it("shows icons first and selects them for an automatic project", () => {
    const markup = renderToStaticMarkup(
      <ProjectIconPickerDialog
        current={null}
        projectName="Test"
        open
        onOpenChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-current="lucide"');
    expect(markup.indexOf(">Icons<")).toBeLessThan(markup.indexOf(">Emoji<"));
    expect(markup).toContain('aria-label="Icon color"');
    expect(markup).not.toContain(">Image<");
  });

  it("offers an image for board and folder icons", () => {
    for (const entityType of ["board", "folder"] as const) {
      const markup = renderToStaticMarkup(
        <ProjectIconPickerDialog
          current={null}
          projectName="Test"
          entityType={entityType}
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />,
      );

      expect(markup).toContain(">Image<");
    }
  });
});
