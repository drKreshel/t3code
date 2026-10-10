import { afterEach, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
