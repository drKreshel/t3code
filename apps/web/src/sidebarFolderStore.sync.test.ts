import { afterEach, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("retains nested folder settlement and its parent through a saved layout reload", async () => {
  const storage = createMemoryStorage();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage }));
  vi.resetModules();
  const { useSidebarFolderStore: store } = await import("./sidebarFolderStore");
  const parentId = store.getState().createFolder({ name: "Tickets", parentId: null });
  const folderId = store.getState().createFolder({ name: "SALON-42", parentId });
  store.getState().setFolderSettled(folderId, true);
  vi.resetModules();
  const { useSidebarFolderStore: reloaded } = await import("./sidebarFolderStore");
  expect(reloaded.getState().settledFolderIds).toEqual([folderId]);
  expect(reloaded.getState().folders.find((folder) => folder.id === folderId)?.parentId).toBe(
    parentId,
  );
  reloaded.getState().setFolderSettled(folderId, false);
  expect(reloaded.getState().settledFolderIds).toEqual([]);
  expect(reloaded.getState().folders.find((folder) => folder.id === folderId)?.parentId).toBe(
    parentId,
  );
});

it("keeps a folder deleted by another tab deleted when this tab next edits its layout", async () => {
  const storage = createMemoryStorage();
  const window = Object.assign(new EventTarget(), { localStorage: storage });
  vi.stubGlobal("window", window);
  vi.resetModules();
  const { useSidebarFolderStore: store } = await import("./sidebarFolderStore");
  store.getState().createFolder({ name: "Old", parentId: null });
  const { name } = store.persist.getOptions();
  const saved = JSON.parse(storage.getItem(name!) as string);
  storage.setItem(name!, JSON.stringify({ ...saved, state: { ...saved.state, folders: [] } }));
  window.dispatchEvent(Object.assign(new Event("storage"), { key: name, storageArea: storage }));
  expect(store.getState().folders).toEqual([]);
  store.getState().createFolder({ name: "New", parentId: null });
  expect(
    JSON.parse(storage.getItem(name!) as string).state.folders.map(
      (folder: { name: string }) => folder.name,
    ),
  ).toEqual(["New"]);
});
