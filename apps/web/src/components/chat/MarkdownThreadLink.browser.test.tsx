import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

vi.mock("../../state/entities", () => ({
  useThreadShell: () => null,
  useThreadRefs: () => [],
  useProject: () => null,
}));

it.each([
  { version: "v1", targetEnvironment: null, expectedEnvironment: "local" },
  { version: "v2", targetEnvironment: EnvironmentId.make("remote"), expectedEnvironment: "remote" },
])(
  "opens a $version thread link even when its shell is unavailable",
  async ({ targetEnvironment, expectedEnvironment }) => {
    await using screen = await render(
      <MarkdownThreadLink
        environmentId={EnvironmentId.make("local")}
        link={{ environmentId: targetEnvironment, threadId: ThreadId.make("linked-thread") }}
        label="Refresh delivery status"
      />,
    );
    const link = screen.getByRole("link", { name: "Thread, Refresh delivery status" });
    await expect.element(link).toHaveAttribute("href", `/${expectedEnvironment}/linked-thread`);
    await userEvent.click(link);
    expect(screen.router?.state.location.pathname).toBe(`/${expectedEnvironment}/linked-thread`);
  },
);
