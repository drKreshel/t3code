/**
 * Skills page (fork): every skill the agents load, filterable by project, with
 * each SKILL.md readable and editable. A global skill that has a copy in the
 * source folder is edited there, and the resync command then updates every
 * agent's copy.
 */
import type { SkillEntry, SkillsList, SkillsProject, SkillsSettings } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { FolderCogIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useSkillFile, useSkillsCommands, useSkillsList } from "../../state/skills";
import { BoardsPageFrame, BoardsStatusMessage } from "../boards/BoardsPageFrame";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

export interface SkillsSearch {
  /** A project id, `global`, or absent for every skill. */
  readonly project?: string;
  readonly q?: string;
}

const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  global: "Global",
  project: "Project",
  builtin: "Built in",
};

interface SkillGroup {
  readonly label: string;
  readonly skills: ReadonlyArray<SkillEntry>;
}

/** A project filter shows that project's skills and every global and built-in one. */
function groupSkills(list: SkillsList, project: string, query: string): ReadonlyArray<SkillGroup> {
  const needle = query.trim().toLowerCase();
  const matches = (skill: SkillEntry) =>
    needle === "" ||
    skill.name.toLowerCase().includes(needle) ||
    (skill.description ?? "").toLowerCase().includes(needle);
  const visible = list.skills.filter(matches);
  const projects =
    project === "all"
      ? list.projects
      : list.projects.filter((candidate) => candidate.id === project);
  return [
    ...(project === "global" ? [] : projects).map((candidate) => ({
      label: candidate.title,
      skills: visible.filter(
        (skill) => skill.scope === "project" && skill.projectId === candidate.id,
      ),
    })),
    { label: "Global", skills: visible.filter((skill) => skill.scope === "global") },
    { label: "Built in", skills: visible.filter((skill) => skill.scope === "builtin") },
  ].filter((group) => group.skills.length > 0);
}

function agentsOf(skill: SkillEntry): ReadonlyArray<string> {
  return [...new Set(skill.loads.map((load) => load.providerName))];
}

function SkillRow(props: { skill: SkillEntry; selected: boolean; onSelect: () => void }) {
  const agents = agentsOf(props.skill);
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/60",
        props.selected && "bg-accent",
      )}
    >
      <span className="w-full truncate font-mono text-xs">{props.skill.name}</span>
      <span className="w-full truncate text-2xs text-muted-foreground">
        {agents.length === 0 ? "Not synced to any agent" : agents.join(" · ")}
        {props.skill.description ? ` — ${props.skill.description}` : ""}
      </span>
    </button>
  );
}

function SettingsPopover(props: { settings: SkillsSettings; onSaved: () => void }) {
  const { saveSettings } = useSkillsCommands();
  const [open, setOpen] = useState(false);
  const [sourceDirectory, setSourceDirectory] = useState(props.settings.sourceDirectory ?? "");
  const [resyncCommand, setResyncCommand] = useState(props.settings.resyncCommand ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const outcome = await saveSettings({ sourceDirectory, resyncCommand });
    setSaving(false);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Settings not saved",
        description: outcome.message,
      });
      return;
    }
    setOpen(false);
    props.onSaved();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        <FolderCogIcon className="size-3.5" />
        Source folder
      </PopoverTrigger>
      <PopoverPopup className="w-96">
        <div className="flex flex-col gap-3">
          <PopoverTitle>Personal skills source</PopoverTitle>
          <p className="text-xs text-muted-foreground">
            Global skills with a copy here are edited here, then the resync command copies them into
            each agent's skills folder.
          </p>
          <label className="flex flex-col gap-1 text-xs">
            Source folder
            <Input
              size="sm"
              font="mono"
              value={sourceDirectory}
              placeholder="~/.ruler/skills"
              onChange={(event) => setSourceDirectory(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Resync command
            <Input
              size="sm"
              font="mono"
              value={resyncCommand}
              placeholder="npx @intellectronica/ruler apply …"
              onChange={(event) => setResyncCommand(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button size="xs" onClick={() => void save()} disabled={saving}>
              Save
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function SkillDetail(props: {
  skill: SkillEntry;
  project: SkillsProject | null;
  settings: SkillsSettings;
  onSaved: () => void;
}) {
  const { skill } = props;
  const readPath = skill.editPath ?? skill.loads[0]?.path ?? null;
  const { file, reload } = useSkillFile(readPath);
  const { save } = useSkillsCommands();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resyncOutput, setResyncOutput] = useState<string | null>(null);
  const content = file?.status === "ready" ? file.value.content : null;
  const text = draft ?? content ?? "";
  const dirty = draft !== null && draft !== content;
  const editable = skill.editPath !== null;

  const onSave = async () => {
    if (skill.editPath === null || draft === null) return;
    setSaving(true);
    const outcome = await save({ path: skill.editPath, content: draft });
    setSaving(false);
    if (!outcome.ok) {
      toastManager.add({ type: "error", title: "Skill not saved", description: outcome.message });
      return;
    }
    const { resync } = outcome.value;
    if (resync !== null && resync.exitCode !== 0) {
      setResyncOutput(resync.output || "The resync command failed without output.");
      toastManager.add({
        type: "error",
        title: "Saved, but the resync failed",
        description: "Agents still see the previous copy.",
      });
    } else {
      setResyncOutput(null);
      toastManager.add({
        type: "success",
        title: resync === null ? "Skill saved" : "Skill saved and synced",
      });
    }
    setDraft(null);
    reload();
    props.onSaved();
  };

  const editNote = !editable
    ? "Shipped by an agent or plugin; read-only here."
    : skill.sourcePath !== null
      ? props.settings.resyncCommand
        ? `Edits go to the source and then run: ${props.settings.resyncCommand}`
        : "Edits go to the source. No resync command is set, so agents keep their old copy until you sync."
      : `Edits go to ${skill.editPath}.`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-mono text-sm font-medium">{skill.name}</h2>
          <Badge variant="outline">
            {skill.scope === "project" && props.project
              ? props.project.title
              : SCOPE_LABEL[skill.scope]}
          </Badge>
          {agentsOf(skill).map((agent) => (
            <Badge key={agent} variant="secondary">
              {agent}
            </Badge>
          ))}
          <div className="ml-auto flex items-center gap-1">
            {dirty ? (
              <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            ) : null}
            <Button size="xs" disabled={!dirty || saving} onClick={() => void onSave()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
        {skill.description ? (
          <p className="text-xs text-muted-foreground">{skill.description}</p>
        ) : null}
        <div className="flex flex-col gap-0.5 font-mono text-2xs text-muted-foreground">
          {skill.sourcePath !== null ? <span>source · {skill.sourcePath}</span> : null}
          {skill.loads.map((load) => (
            <span key={`${load.providerName}:${load.path}`}>
              {load.providerName.toLowerCase()} · {load.path}
              {load.enabled ? "" : " (off)"}
            </span>
          ))}
        </div>
        <p className="text-2xs text-muted-foreground">{editNote}</p>
        {resyncOutput !== null ? (
          <pre className="max-h-32 overflow-auto rounded-md bg-destructive/8 p-2 font-mono text-2xs whitespace-pre-wrap text-destructive-foreground">
            {resyncOutput}
          </pre>
        ) : null}
      </div>
      {file === null ? (
        <BoardsStatusMessage>This skill has no file to show.</BoardsStatusMessage>
      ) : file.status === "loading" ? (
        <BoardsStatusMessage>Loading…</BoardsStatusMessage>
      ) : file.status === "error" ? (
        <BoardsStatusMessage>{file.message}</BoardsStatusMessage>
      ) : (
        <textarea
          aria-label={`${skill.name} SKILL.md`}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none"
          spellCheck={false}
          readOnly={!editable}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
    </div>
  );
}

export function SkillsPage() {
  const search = useSearch({ from: "/skills" });
  const navigate = useNavigate({ from: "/skills" });
  const { list, reload } = useSkillsList();
  const [query, setQuery] = useState(search.q ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const project = search.project ?? "all";

  const groups = useMemo(
    () => (list.status === "ready" ? groupSkills(list.value, project, query) : []),
    [list, project, query],
  );
  const visible = useMemo(() => groups.flatMap((group) => group.skills), [groups]);
  const selected =
    visible.find((skill) => skill.id === selectedId) ??
    visible.find((skill) => skill.name === query.trim()) ??
    visible[0] ??
    null;

  const actions =
    list.status === "ready" ? (
      <>
        <SettingsPopover
          key={JSON.stringify(list.value.settings)}
          settings={list.value.settings}
          onSaved={reload}
        />
        <Button size="xs" variant="ghost" onClick={reload}>
          <RefreshCwIcon className="size-3.5" />
          Rescan
        </Button>
      </>
    ) : null;

  return (
    <BoardsPageFrame root="Skills" crumbs={[]} actions={actions} scroll={false}>
      {list.status === "loading" ? (
        <BoardsStatusMessage>Scanning skills…</BoardsStatusMessage>
      ) : list.status === "error" ? (
        <BoardsStatusMessage>{list.message}</BoardsStatusMessage>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-80 shrink-0 flex-col border-r border-border/60">
            <div className="flex flex-col gap-2 p-2">
              <Input
                size="sm"
                type="search"
                value={query}
                placeholder="Search skills"
                onChange={(event) => setQuery(event.target.value)}
              />
              <Select
                value={project}
                items={{
                  all: "All projects",
                  global: "Global only",
                  ...Object.fromEntries(list.value.projects.map((item) => [item.id, item.title])),
                }}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  void navigate({
                    search: ({ q }) => ({
                      ...(q === undefined ? {} : { q }),
                      ...(value === "all" ? {} : { project: value }),
                    }),
                    replace: true,
                  });
                }}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="all">All projects</SelectItem>
                  <SelectItem value="global">Global only</SelectItem>
                  {list.value.projects.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-3 px-2 pb-3">
                {groups.length === 0 ? (
                  <p className="px-2 text-xs text-muted-foreground">No skills match.</p>
                ) : (
                  groups.map((group) => (
                    <section key={group.label} className="flex flex-col gap-0.5">
                      <h3 className="px-2 text-2xs font-medium text-muted-foreground">
                        {group.label} · {group.skills.length}
                      </h3>
                      {group.skills.map((skill) => (
                        <SkillRow
                          key={skill.id}
                          skill={skill}
                          selected={skill.id === selected?.id}
                          onSelect={() => setSelectedId(skill.id)}
                        />
                      ))}
                    </section>
                  ))
                )}
              </div>
            </ScrollArea>
          </aside>
          {selected === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <SparklesIcon className="size-6" />
              <p className="text-sm">Pick a skill to read or edit it.</p>
            </div>
          ) : (
            <SkillDetail
              key={selected.id}
              skill={selected}
              project={list.value.projects.find((item) => item.id === selected.projectId) ?? null}
              settings={list.value.settings}
              onSaved={reload}
            />
          )}
        </div>
      )}
    </BoardsPageFrame>
  );
}
