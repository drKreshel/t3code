/**
 * A SKILL.md shown two ways: rendered, with its frontmatter as fields, or as
 * highlighted markdown source in the same editor the Files panel uses.
 */
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { ScrollArea } from "../ui/scroll-area";
import { splitFrontmatter } from "./skillFrontmatter";

export function SkillPreview(props: { readonly path: string; readonly text: string }) {
  const { fields, body } = useMemo(() => splitFrontmatter(props.text), [props.text]);
  const directory = props.path.slice(0, Math.max(props.path.lastIndexOf("/"), 0)) || "/";
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
        {fields.length > 0 ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-md border border-border/60 px-3 py-2 text-xs">
            {fields.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <ChatMarkdown text={body} cwd={directory} imageBaseDir={directory} />
      </div>
    </ScrollArea>
  );
}

/**
 * Highlighted SKILL.md source. Editable when `onChange` is set; remount it
 * (change its `key`) to load new contents, since typing must not reset it.
 */
export function SkillSourceEditor(props: {
  readonly path: string;
  readonly contents: string;
  readonly onChange?: ((contents: string) => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const { onChange } = props;
  // The editor owns the text after mount; feeding edits back would reset it.
  const [initialContents] = useState(props.contents);
  const editor = useMemo(
    () =>
      new Editor({
        onChange: (file) => onChange?.(file.contents),
      }),
    [onChange],
  );
  useEffect(() => () => editor.cleanUp(), [editor]);
  const file = (
    <File
      file={{ name: "SKILL.md", contents: initialContents, cacheKey: `skill:${props.path}` }}
      options={{
        disableFileHeader: true,
        overflow: wordWrap ? "wrap" : "scroll",
        theme: resolveDiffThemeName(resolvedTheme),
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        themeType: resolvedTheme,
      }}
      className="min-h-full"
      contentEditable={onChange !== undefined}
    />
  );
  const surface = (
    <Virtualizer
      key={resolvedTheme}
      className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
      config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
    >
      {file}
    </Virtualizer>
  );
  return (
    <DiffWorkerPoolProvider>
      {onChange === undefined ? surface : <EditProvider editor={editor}>{surface}</EditProvider>}
    </DiffWorkerPoolProvider>
  );
}
