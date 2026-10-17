import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

// Settings, Usage, and Pull Requests are side trips: Escape (and Settings'
// sidebar Back button) returns to the main app, which is everything else.
// Legacy `/projects/<key>` links redirect into settings, so they count too and
// are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;

// Mount once in the app shell. Records the latest main app URL so leaving a
// utility page returns there no matter how many were visited since.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}
