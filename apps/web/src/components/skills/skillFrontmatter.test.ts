import { describe, expect, it } from "vite-plus/test";

import { splitFrontmatter } from "./skillFrontmatter";

describe("splitFrontmatter", () => {
  it("separates frontmatter fields, joining indented continuations, from the body", () => {
    expect(
      splitFrontmatter(
        '---\nname: grill-me\ndescription: >\n  Ask hard\n  questions.\nlicense: "MIT"\n---\n# Title\n',
      ),
    ).toEqual({
      fields: [
        ["name", "grill-me"],
        ["description", "Ask hard questions."],
        ["license", "MIT"],
      ],
      body: "# Title\n",
    });
    expect(splitFrontmatter("# No frontmatter")).toEqual({ fields: [], body: "# No frontmatter" });
  });
});
