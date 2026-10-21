// @effect-diagnostics nodeBuiltinImport:off - reads the installed web JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const maintain = source.slice(
    source.indexOf("function doMaintainScrollAtEnd("),
    source.indexOf("// src/utils/requestAdjust.ts"),
  );
  const frames: Array<() => void> = [];
  const scrollToEnd = vi.fn();
  // The bundle's threshold flag, a full viewport here as the chat timeline sets it.
  const values = new Map<string, unknown>([["isWithinMaintainScrollAtEndThreshold", true]]);
  const state = {
    props: {
      maintainScrollAtEnd: { animated: false } as { animated: boolean } | false,
      horizontal: false,
    },
    didContainersLayout: true,
    pendingNativeMVCPAdjust: undefined,
    refScroller: { current: { scrollToEnd } },
    scroll: 1000,
    scrollLength: 300,
    maintainingScrollAtEnd: undefined as string | undefined,
    pendingMaintainScrollAtEnd: false,
  };
  const ctx = { state };
  const doMaintainScrollAtEnd = NodeVM.runInNewContext(`${maintain}\ndoMaintainScrollAtEnd`, {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setTimeout: (callback: () => void) => callback(),
    peek$: (_ctx: unknown, key: string) => values.get(key),
    getContentSize: () => 1300,
    isHorizontalRTL: () => false,
  }) as (context: typeof ctx) => boolean;
  return {
    state,
    scrollToEnd,
    requestMaintain: () => doMaintainScrollAtEnd(ctx),
    advance() {
      for (const frame of frames.splice(0)) frame();
    },
  };
}

describe.each(["react.js", "react.mjs"])("maintainScrollAtEnd queued frame (%s)", (bundle) => {
  it("pins to the end when nothing moved before the frame", () => {
    const list = createList(bundle);
    list.requestMaintain();
    list.advance();
    expect(list.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("leaves the user where they scrolled up to, even within the threshold", () => {
    const list = createList(bundle);
    list.requestMaintain();
    list.state.scroll = 880;
    list.advance();
    expect(list.scrollToEnd).not.toHaveBeenCalled();
    expect(list.state.maintainingScrollAtEnd).toBeUndefined();
  });

  it("does not pin after the app turned maintainScrollAtEnd off", () => {
    const list = createList(bundle);
    list.requestMaintain();
    list.state.props.maintainScrollAtEnd = false;
    list.advance();
    expect(list.scrollToEnd).not.toHaveBeenCalled();
  });
});
