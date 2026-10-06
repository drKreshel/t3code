import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

import { frontmatterDescription, mergeSkills } from "./skillsLogic.ts";

const WEB = ProjectId.make("web");

describe("mergeSkills", () => {
  it("merges a synced personal skill across agents and projects into one global row", () => {
    const skills = mergeSkills(
      [
        {
          providerName: "Claude",
          projectId: WEB,
          projectRoot: "/code/web",
          skills: [
            {
              name: "grill-me",
              path: "/home/.claude/skills/grill-me/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "deploy",
              path: "/code/web/.claude/skills/deploy/SKILL.md",
              scope: "project",
              enabled: true,
            },
          ],
        },
        {
          providerName: "Codex",
          projectId: null,
          projectRoot: null,
          skills: [
            {
              name: "grill-me",
              path: "/home/.agents/skills/grill-me/SKILL.md",
              scope: "user",
              enabled: true,
            },
            {
              name: "pdf:pdf",
              path: "/home/.codex/plugins/pdf/SKILL.md",
              scope: "user",
              enabled: true,
            },
          ],
        },
      ],
      new Map([
        ["grill-me", "/home/.ruler/skills/grill-me/SKILL.md"],
        ["unsynced", "/home/.ruler/skills/unsynced/SKILL.md"],
      ]),
    );
    expect(
      skills.map(({ id, scope, projectId, editPath, loads }) => ({
        id,
        scope,
        projectId,
        editPath,
        agents: loads.map((load) => load.providerName),
      })),
    ).toEqual([
      {
        id: "project:web:deploy",
        scope: "project",
        projectId: WEB,
        editPath: "/code/web/.claude/skills/deploy/SKILL.md",
        agents: ["Claude"],
      },
      {
        id: "global:grill-me",
        scope: "global",
        projectId: null,
        editPath: "/home/.ruler/skills/grill-me/SKILL.md",
        agents: ["Claude", "Codex"],
      },
      {
        id: "builtin:pdf:pdf",
        scope: "builtin",
        projectId: null,
        editPath: null,
        agents: ["Codex"],
      },
      {
        id: "global:unsynced",
        scope: "global",
        projectId: null,
        editPath: "/home/.ruler/skills/unsynced/SKILL.md",
        agents: [],
      },
    ]);
  });
});

describe("frontmatterDescription", () => {
  it("reads a quoted description", () => {
    expect(frontmatterDescription('---\nname: x\ndescription: "Does x."\n---\nbody')).toBe(
      "Does x.",
    );
    expect(frontmatterDescription("no frontmatter")).toBeNull();
  });
});
