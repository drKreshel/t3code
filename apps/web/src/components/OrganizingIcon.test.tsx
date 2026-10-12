import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OrganizingIcon } from "./OrganizingIcon";

describe("OrganizingIcon", () => {
  it("renders a custom image with a board or folder type badge", () => {
    const icon = { kind: "image", dataUrl: "data:image/png;base64,aWNvbg==" } as const;

    for (const kind of ["board", "folder"] as const) {
      const markup = renderToStaticMarkup(<OrganizingIcon icon={icon} kind={kind} />);
      expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
      expect(markup).toContain("-right-1 -bottom-0.5");
      expect(markup).toContain("<svg");
    }
  });
});
