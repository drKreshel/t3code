import { useNavigate } from "@tanstack/react-router";
import { HandIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { isRecentLocalTicketMove, useBoards } from "../../state/boards";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { indexBoards, ticketLabel, ticketsNewlyInAttention } from "./boards.logic";

/**
 * Tells Kreshel when a ticket lands in a Needs you column, for example after
 * an agent's request_human. Chats waiting on an approval or an answer already
 * notify through the thread notifications, so only the column counts here.
 * Follows the same notification settings; mount once, beside those.
 */
export function BoardsNotificationCoordinator() {
  const boards = useBoards();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const previous = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (boards.status !== "ready") return;
    const { current, added } = ticketsNewlyInAttention(previous.current, boards.snapshot);
    previous.current = current;
    if (added.length === 0) return;
    const index = indexBoards(boards.snapshot);
    for (const ticket of added) {
      if (isRecentLocalTicketMove(ticket.id)) continue;
      const board = index.boardById.get(ticket.boardId);
      if (!board) continue;
      const label = ticketLabel(ticket, index);
      const title = `${label} needs you`;
      const body = ticket.attentionReason ?? ticket.title;
      const open = () =>
        void navigate({
          to: "/boards/$boardKey/$ticketNumber",
          params: { boardKey: board.key, ticketNumber: String(ticket.number) },
        });
      if (hasNotificationSound(mode)) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (focused) {
        if (!inAppNotificationsEnabled) continue;
        const toastId = toastManager.add({
          type: "warning",
          title,
          description: body,
          data: {
            hideCopyButton: true,
            leadingIcon: <HandIcon aria-hidden className="size-4 text-warning-foreground" />,
          },
          actionProps: {
            children: "Open ticket",
            onClick: () => {
              toastManager.close(toastId);
              open();
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      ) {
        continue;
      }
      try {
        const notification = new Notification(title, {
          body,
          tag: `ticket:${ticket.id}`,
          silent: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          open();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [boards, inAppNotificationsEnabled, mode, navigate]);

  return null;
}
