import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { sidebarFolderClientAtom, sidebarFolderRespond } from "../rpc/sidebarFolders";
import { useConnectedEnvironmentIds } from "../state/environments";

function FolderClient({ environmentId }: { environmentId: EnvironmentId }) {
  useAtomValue(sidebarFolderClientAtom(environmentId));
  return null;
}

function WritableFolderClient({ environmentId }: { environmentId: EnvironmentId }) {
  const allowed = useAtomValue(sidebarFolderRespond.permissionAtom(environmentId));
  return allowed ? <FolderClient environmentId={environmentId} /> : null;
}

export function SidebarFolderToolsCoordinator() {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <WritableFolderClient key={environmentId} environmentId={environmentId} />
  ));
}
