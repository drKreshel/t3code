/**
 * Agent context panel (fork): what this thread's agent receives that the chat
 * does not show. The instructions T3 injects at session start, the T3 tools it
 * can call, and the skills its provider loads for this thread's folder.
 */
import type {
  AgentContextInstruction,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useProviderWorkspaceSkillsScan, useThreadAgentContext } from "~/state/agentContext";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

const SCOPE_LABELS: Record<string, string> = {
  user: "Global",
  project: "This project",
  repo: "This project",
  system: "Built in",
  admin: "Admin",
};
const SCOPE_ORDER = ["This project", "Global", "Built in", "Admin"];

function scopeLabel(scope: string | undefined): string {
  if (scope === undefined) return "Other";
  return SCOPE_LABELS[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1);
}

function Section(props: { title: string; count?: number; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-xs font-medium text-foreground">
        {props.title}
        {props.count === undefined ? null : (
          <span className="ml-1 text-muted-foreground">{props.count}</span>
        )}
      </h3>
      {props.note ? <p className="px-1 text-2xs text-muted-foreground">{props.note}</p> : null}
      <div className="flex flex-col gap-1">{props.children}</div>
    </section>
  );
}

function InstructionBlock({ instruction }: { instruction: AgentContextInstruction }) {
  if (instruction.text === null) {
    return (
      <div className="rounded-md border border-dashed border-border px-2 py-1.5">
        <p className="font-mono text-xs text-muted-foreground">[[{instruction.title}]]</p>
        <p className="text-2xs text-muted-foreground">{instruction.channel}. T3 cannot read it.</p>
      </div>
    );
  }
  return (
    <details className="rounded-md border border-border">
      <summary className="cursor-pointer px-2 py-1.5 text-xs">
        <span className="font-medium">{instruction.title}</span>
        <span className="ml-1.5 text-2xs text-muted-foreground">{instruction.channel}</span>
      </summary>
      <pre className="max-h-96 overflow-auto border-t border-border px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
        {instruction.text}
      </pre>
    </details>
  );
}

function ItemRow(props: {
  name: string;
  detail: string;
  meta?: string | undefined;
  muted?: boolean;
}) {
  return (
    <details className={props.muted ? "opacity-60" : undefined}>
      <summary className="cursor-pointer truncate rounded-sm px-1 py-0.5 text-xs hover:bg-accent/60">
        <span className="font-mono">{props.name}</span>
        {props.meta ? (
          <span className="ml-1.5 text-2xs text-muted-foreground">{props.meta}</span>
        ) : null}
      </summary>
      <p className="px-1 pt-0.5 pb-1.5 text-2xs whitespace-pre-wrap text-muted-foreground">
        {props.detail}
      </p>
    </details>
  );
}

function SkillGroups({
  skills,
  projectId,
}: {
  skills: ReadonlyArray<ServerProviderSkill>;
  projectId: string | null;
}) {
  const groups = useMemo(() => {
    const byScope = new Map<string, ServerProviderSkill[]>();
    for (const skill of skills) {
      const label = scopeLabel(skill.scope);
      byScope.set(label, [...(byScope.get(label) ?? []), skill]);
    }
    const rank = (label: string) =>
      SCOPE_ORDER.includes(label) ? SCOPE_ORDER.indexOf(label) : SCOPE_ORDER.length;
    return [...byScope.entries()]
      .toSorted(([left], [right]) => rank(left) - rank(right))
      .map(([label, group]) => ({
        label,
        skills: group.toSorted((left, right) => left.name.localeCompare(right.name)),
      }));
  }, [skills]);
  if (groups.length === 0) {
    return <p className="px-1 text-2xs text-muted-foreground">No skills found for this folder.</p>;
  }
  return groups.map((group) => (
    <div key={group.label} className="flex flex-col">
      <p className="px-1 pt-1 text-2xs font-medium text-muted-foreground">
        {group.label} · {group.skills.length}
      </p>
      {group.skills.map((skill) => (
        <Link
          key={skill.path}
          to="/skills"
          search={{ q: skill.name, ...(projectId === null ? {} : { project: projectId }) }}
          title={`${skill.description ?? "No description."}\n${skill.path}`}
          className={cn(
            "truncate rounded-sm px-1 py-0.5 font-mono text-xs hover:bg-accent/60",
            !skill.enabled && "opacity-60",
          )}
        >
          {skill.name}
          {skill.enabled ? null : (
            <span className="ml-1.5 text-2xs text-muted-foreground">off</span>
          )}
        </Link>
      ))}
    </div>
  ));
}

export function AgentContextPanel(props: {
  threadRef: ScopedThreadRef;
  provider: ServerProvider | null;
  /** The folder the agent works in: the thread's worktree, or the project root. */
  cwd: string | null;
  /** Filters the Skills page that a skill opens in. */
  projectId: string | null;
}) {
  const { state, reload } = useThreadAgentContext(props.threadRef);
  useProviderWorkspaceSkillsScan(props.threadRef, props.provider, props.cwd);
  const skills = props.provider ? resolveProviderSkillsForCwd(props.provider, props.cwd) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-2">
          {state.status === "loading" ? (
            <p className="px-1 text-xs text-muted-foreground">Loading…</p>
          ) : state.status === "error" ? (
            <p className="px-1 text-xs text-destructive-foreground">{state.message}</p>
          ) : (
            <>
              <Section
                title="Session instructions"
                note={
                  state.context.exact
                    ? "What the agent receives before your first message, in order."
                    : `T3 cannot reproduce exactly how ${state.context.providerName} receives this text; it is the content T3 adds.`
                }
              >
                {state.context.instructions.map((instruction) => (
                  <InstructionBlock key={instruction.title} instruction={instruction} />
                ))}
              </Section>
              <Section
                title="T3 tools"
                count={state.context.tools.length}
                note={`Served by the t3-code MCP server, next to ${state.context.providerName}'s own tools. Tools marked off are switched off in settings; calls to them fail.`}
              >
                {state.context.tools.map((tool) => (
                  <ItemRow
                    key={tool.name}
                    name={tool.name}
                    meta={tool.enabled ? (tool.readonly ? "read-only" : undefined) : "off"}
                    muted={!tool.enabled}
                    detail={tool.description}
                  />
                ))}
              </Section>
            </>
          )}
          <Section
            title="Skills"
            count={skills.length}
            note={
              props.provider
                ? `What ${props.provider.displayName ?? "the provider"} loads for ${props.cwd ?? "this thread"}.`
                : "The thread's provider is not available on this server."
            }
          >
            <SkillGroups skills={skills} projectId={props.projectId} />
          </Section>
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-end border-t border-border/60 px-2 py-1.5">
        <Button size="xs" variant="ghost" onClick={reload}>
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      </footer>
    </div>
  );
}
