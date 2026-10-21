import { describe, expect, it } from "vite-plus/test";

import {
  resizeBrowserViewportFromRail,
  resolveBrowserLayoutZoomFactor,
  resolveBrowserViewportLayout,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";

describe("resolveBrowserViewportLayout", () => {
  it("preserves the last logical viewport when fitting a fill-mode surface", () => {
    expect(
      resolveFittedBrowserViewport({ _tag: "fill" }, { width: 320, height: 200, scale: 0.25 }),
    ).toEqual({ _tag: "freeform", width: 1280, height: 800 });
  });

  it("draws a webview smaller in a zoomed app so its guest keeps the requested viewport", () => {
    // App zoom level 4: each app CSS pixel covers 2.0736 device pixels.
    const appZoomFactor = 1.2 ** 4;
    const zoomFactor = resolveBrowserLayoutZoomFactor(1, appZoomFactor);
    const layout = resolveBrowserViewportLayout(
      { width: 1280, height: 800 },
      { _tag: "freeform", width: 1280, height: 800 },
      zoomFactor,
    );
    expect(layout.viewportScale).toBe(1);
    expect(layout.viewportWidth * appZoomFactor).toBeCloseTo(1280);
    expect(layout.viewportHeight * appZoomFactor).toBeCloseTo(800);
    expect(resolveBrowserLayoutZoomFactor(1.5, 1)).toBe(1.5);
    expect(resolveBrowserLayoutZoomFactor(1, Number.NaN)).toBe(1);
  });
  it("keeps the grabbed rail under the pointer across centered layout boundaries", () => {
    const available = { width: 1120, height: 818 };
    expect(
      resizeBrowserViewportFromRail(
        { width: 1120, height: 818 },
        { x: -100, y: -50 },
        available,
        1,
        "southeast",
      ),
    ).toEqual({ width: 920, height: 718 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 800, height: 600 },
        { x: 300, y: 0 },
        { width: 1200, height: 800 },
        1,
        "east",
      ),
    ).toEqual({ width: 1300, height: 600 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 560, height: 409 },
        { x: -100, y: 0 },
        available,
        2,
        "east",
      ),
    ).toEqual({ width: 460, height: 409 });
  });
});
