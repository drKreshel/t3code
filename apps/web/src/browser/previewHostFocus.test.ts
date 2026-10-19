// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { holdPreviewHostFocus } from "./previewHostFocus";

const TAB = "runtime-tab";

const mount = (tagName: string, previewTab?: string) => {
  const element = document.createElement(tagName);
  element.tabIndex = -1;
  if (previewTab) element.setAttribute("data-preview-tab", previewTab);
  document.body.append(element);
  return element;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("holdPreviewHostFocus", () => {
  it("gives focus back to the composer after agent input focuses the page", () => {
    const composer = mount("textarea");
    const webview = mount("webview", TAB);
    composer.focus();

    const release = holdPreviewHostFocus(TAB);
    webview.focus();
    release();

    expect(document.activeElement).toBe(composer);
  });

  it("gives focus back once overlapping input in two tabs ends", () => {
    const composer = mount("textarea");
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    composer.focus();

    const releaseFirst = holdPreviewHostFocus(TAB);
    first.focus();
    // Starts while the first input holds focus in its page, and ends last.
    const releaseSecond = holdPreviewHostFocus("other-tab");
    second.focus();
    releaseFirst();
    releaseSecond();

    expect(document.activeElement).toBe(composer);
  });

  it("keeps the user's page when overlapping input ends in reverse order", () => {
    const first = mount("webview", TAB);
    const second = mount("webview", "other-tab");
    second.focus();

    const releaseFirst = holdPreviewHostFocus(TAB);
    first.focus();
    // Starts while the first input holds focus in its page, and ends first.
    const releaseSecond = holdPreviewHostFocus("other-tab");
    second.focus();
    releaseSecond();
    releaseFirst();

    expect(document.activeElement).toBe(second);
  });

  it("ignores input that never ends", () => {
    const composer = mount("textarea");
    const stuck = mount("webview", "stuck-tab");
    const webview = mount("webview", TAB);
    const other = mount("webview", "other-tab");
    composer.focus();

    holdPreviewHostFocus("stuck-tab");
    const release = holdPreviewHostFocus(TAB);
    webview.focus();
    release();
    expect(document.activeElement).toBe(composer);

    // The user opens the stuck tab's page themselves.
    stuck.focus();
    const releaseOther = holdPreviewHostFocus("other-tab");
    other.focus();
    releaseOther();
    expect(document.activeElement).toBe(stuck);
  });

  it("leaves no focus in the page when the composer can no longer take focus", () => {
    const composer = mount("div");
    const webview = mount("webview", TAB);
    composer.focus();

    const release = holdPreviewHostFocus(TAB);
    webview.focus();
    // Like the editor going read-only for an approval request.
    composer.removeAttribute("tabindex");
    release();

    expect(document.activeElement).toBe(document.body);
  });

  it("leaves no focus in the page when nothing in the app had focus", () => {
    const webview = mount("webview", TAB);

    const release = holdPreviewHostFocus(TAB);
    webview.focus();
    release();

    expect(document.activeElement).toBe(document.body);
  });

  it("keeps focus in the page when the user was already typing there", () => {
    const webview = mount("webview", TAB);
    webview.focus();

    holdPreviewHostFocus(TAB)();

    expect(document.activeElement).toBe(webview);
  });
});
