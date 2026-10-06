/** Splits a SKILL.md into its frontmatter fields and markdown body. */
/** Frontmatter `key: value` lines and the markdown body after it. */
export function splitFrontmatter(text: string): {
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: [], body: text };
  const fields: Array<readonly [string, string]> = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) {
      const value = (field[2] ?? "").trim();
      // `>` and `|` only announce a block of indented lines below.
      fields.push([
        field[1] ?? "",
        /^[>|][-+]?$/.test(value) ? "" : value.replace(/^["']|["']$/g, ""),
      ]);
    } else if (fields.length > 0 && /^\s+\S/.test(line)) {
      // A folded or indented continuation belongs to the previous field.
      const [key, value] = fields.at(-1)!;
      fields[fields.length - 1] = [key, `${value} ${line.trim()}`.trim()];
    }
  }
  return { fields, body: text.slice(match[0].length) };
}
