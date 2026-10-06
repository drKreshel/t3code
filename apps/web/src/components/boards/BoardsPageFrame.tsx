import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export interface BoardsCrumb {
  readonly label: string;
  /** Omitted on the current page. */
  readonly to?: { readonly boardKey?: string };
}

/**
 * Top bar and body shared by the boards screens. `scroll` wraps the body in a
 * vertical scroll area; the board view scrolls its columns itself.
 */
export function BoardsPageFrame({
  root = "Boards",
  crumbs,
  actions,
  scroll = true,
  children,
}: {
  /** The first crumb, and the page it links to. */
  readonly root?: "Boards" | "Automations";
  readonly crumbs: ReadonlyArray<BoardsCrumb>;
  readonly actions?: ReactNode;
  readonly scroll?: boolean;
  readonly children: ReactNode;
}) {
  const trail: ReadonlyArray<BoardsCrumb> = [{ label: root, to: {} }, ...crumbs];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel={`${root} breadcrumb`} className="min-w-0 flex-1">
            {trail.map((crumb, index) => {
              const current = index === trail.length - 1;
              return [
                index > 0 ? <WorkspaceBreadcrumbSeparator key={`sep-${crumb.label}`} /> : null,
                <WorkspaceBreadcrumbItem key={crumb.label} current={current}>
                  {current || crumb.to === undefined ? (
                    <h1 className="min-w-0">
                      <WorkspaceBreadcrumbText>{crumb.label}</WorkspaceBreadcrumbText>
                    </h1>
                  ) : crumb.to.boardKey === undefined ? (
                    <Link
                      className="hover:text-foreground"
                      to={root === "Boards" ? "/boards" : "/automations"}
                    >
                      <WorkspaceBreadcrumbText>{crumb.label}</WorkspaceBreadcrumbText>
                    </Link>
                  ) : (
                    <Link
                      className="hover:text-foreground"
                      to="/boards/$boardKey"
                      params={{ boardKey: crumb.to.boardKey }}
                    >
                      <WorkspaceBreadcrumbText>{crumb.label}</WorkspaceBreadcrumbText>
                    </Link>
                  )}
                </WorkspaceBreadcrumbItem>,
              ];
            })}
          </WorkspaceBreadcrumb>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </WorkspacePageHeader>
        {scroll ? <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea> : children}
      </div>
    </SidebarInset>
  );
}

/** Loading and unavailable states, in the frame so the top bar stays put. */
export function BoardsStatusMessage({ children }: { readonly children: ReactNode }) {
  return <p className="px-6 pt-6 text-sm text-muted-foreground">{children}</p>;
}
