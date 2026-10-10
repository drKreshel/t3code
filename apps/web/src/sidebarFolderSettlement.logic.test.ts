import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { folderThreadSettlementTargets } from "./sidebarFolderSettlement.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = (id: string, environmentId = local) => scopeThreadRef(environmentId, ThreadId.make(id));
const key = (id: string, environmentId = local) => scopedThreadKey(ref(id, environmentId));
type Shell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "archivedAt" | "deletedAt" | "settledOverride"
>;
const shell = (overrides: Partial<Shell> = {}): Shell => ({
  environmentId: local,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  ...overrides,
});

it("settles canonical members of a collapsed folder, skipping archived, deleted and unsupported chats", () => {
  const shells = new Map<string, Shell>([
    [key("hidden"), shell()],
    [key("archived"), shell({ archivedAt: "2026-10-09" })],
    [key("deleted"), shell({ deletedAt: "2026-10-09" })],
    [key("already"), shell({ settledOverride: "settled" })],
    [key("remote", remote), shell({ environmentId: remote })],
  ]);
  expect(
    folderThreadSettlementTargets(
      [...shells.keys(), key("missing"), "invalid"],
      true,
      (ref) => shells.get(scopedThreadKey(ref)) ?? null,
      (env) => env === local,
      new Set(),
    ),
  ).toEqual([ref("hidden")]);
});

it("unsettles hidden explicitly or automatically settled chats", () => {
  const shells = new Map<string, Shell>([
    [key("explicit"), shell({ settledOverride: "settled" })],
    [key("automatic"), shell()],
    [key("active"), shell()],
  ]);
  expect(
    folderThreadSettlementTargets(
      [...shells.keys()],
      false,
      (ref) => shells.get(scopedThreadKey(ref)) ?? null,
      () => true,
      new Set([key("automatic")]),
    ),
  ).toEqual([ref("explicit"), ref("automatic")]);
});
