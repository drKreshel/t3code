/**
 * Fork: merges what each agent reports for each project into one row per
 * skill. A global skill appears in every project's scan and under several
 * agents (a synced personal skill is copied into each agent's folder), so it
 * is keyed by name; a project skill is keyed by its project and name.
 */
import type {
  ProjectId,
  ServerProviderSkill,
  SkillEntry,
  SkillLoad,
  SkillScope,
} from "@t3tools/contracts";

export interface SkillScan {
  readonly providerName: string;
  /** Null for a scan without a project folder. */
  readonly projectId: ProjectId | null;
  readonly projectRoot: string | null;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const PROJECT_SCOPES = new Set(["project", "repo", "workspace", "local"]);
const BUILTIN_SCOPES = new Set(["system", "admin", "plugin", "bundled", "builtin"]);

/** A skill path that names its folder instead of the file is read as `<folder>/SKILL.md`. */
export function skillFilePath(path: string): string {
  return /\.md$/i.test(path) ? path : `${path.replace(/[\\/]+$/, "")}/SKILL.md`;
}

function isInside(path: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, "");
  return path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

function classify(skill: ServerProviderSkill, scan: SkillScan): SkillScope {
  // Plugin skills are namespaced `plugin:skill` and live in a plugin cache.
  if (skill.name.includes(":") || BUILTIN_SCOPES.has(skill.scope ?? "")) return "builtin";
  if (scan.projectRoot !== null && isInside(skill.path, scan.projectRoot)) return "project";
  if (PROJECT_SCOPES.has(skill.scope ?? "") && scan.projectId !== null) return "project";
  return "global";
}

/**
 * One entry per skill. `sourceSkills` maps a name to its SKILL.md in the
 * source folder; a source skill no agent loads yet still gets a row.
 */
export function mergeSkills(
  scans: ReadonlyArray<SkillScan>,
  sourceSkills: ReadonlyMap<string, string>,
): ReadonlyArray<SkillEntry> {
  const entries = new Map<
    string,
    {
      name: string;
      description: string | null;
      scope: SkillScope;
      projectId: ProjectId | null;
      loads: SkillLoad[];
    }
  >();
  for (const scan of scans) {
    for (const skill of scan.skills) {
      const scope = classify(skill, scan);
      const projectId = scope === "project" ? scan.projectId : null;
      const id =
        scope === "project" ? `project:${projectId}:${skill.name}` : `${scope}:${skill.name}`;
      const entry = entries.get(id) ?? {
        name: skill.name,
        description: null,
        scope,
        projectId,
        loads: [],
      };
      entry.description ??= skill.description ?? null;
      const path = skillFilePath(skill.path);
      if (
        !entry.loads.some((load) => load.providerName === scan.providerName && load.path === path)
      ) {
        entry.loads.push({ providerName: scan.providerName, path, enabled: skill.enabled });
      }
      entries.set(id, entry);
    }
  }
  for (const name of sourceSkills.keys()) {
    if (!entries.has(`global:${name}`)) {
      entries.set(`global:${name}`, {
        name,
        description: null,
        scope: "global",
        projectId: null,
        loads: [],
      });
    }
  }
  return [...entries.entries()]
    .map(([id, entry]) => {
      const sourcePath = entry.scope === "global" ? (sourceSkills.get(entry.name) ?? null) : null;
      return {
        id,
        ...entry,
        sourcePath,
        editPath: sourcePath ?? (entry.scope === "builtin" ? null : (entry.loads[0]?.path ?? null)),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** The `description` from a SKILL.md frontmatter, for source skills no agent reported. */
export function frontmatterDescription(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const line = frontmatter
    ?.split(/\r?\n/)
    .find((candidate) => candidate.startsWith("description:"));
  const value = line
    ?.slice("description:".length)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value ? value : null;
}
