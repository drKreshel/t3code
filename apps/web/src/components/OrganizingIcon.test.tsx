import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OrganizingIcon } from "./OrganizingIcon";

describe("OrganizingIcon", () => {
  it("renders a custom image with a board type badge", () => {
    const icon = { kind: "image", dataUrl: "data:image/png;base64,aWNvbg==" } as const;

    const markup = renderToStaticMarkup(<OrganizingIcon icon={icon} />);
    expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
    expect(markup).toContain("-right-1 -bottom-0.5");
    expect(markup).toContain("<svg");
  });
});
