import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ORGANIZING_ICON_MAX_DATA_URL_LENGTH,
  OrganizingIconOverride,
} from "./forkOrganizingIcon.ts";

const decode = Schema.decodeUnknownSync(OrganizingIconOverride);

describe("OrganizingIconOverride", () => {
  it("accepts bounded bitmap data URLs", () => {
    const icon = { kind: "image", dataUrl: "data:image/webp;base64,aWNvbg==" };
    expect(decode(icon)).toEqual(icon);
  });

  it("rejects remote, vector, malformed, and oversized images", () => {
    for (const dataUrl of [
      "https://example.com/icon.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,a",
      "data:image/png;base64,not valid",
      `data:image/png;base64,${"a".repeat(ORGANIZING_ICON_MAX_DATA_URL_LENGTH)}`,
    ]) {
      expect(() => decode({ kind: "image", dataUrl })).toThrow();
    }
  });
});
