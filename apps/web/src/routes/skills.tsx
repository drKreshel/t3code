import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage, type SkillsSearch } from "../components/skills/SkillsPage";

export const Route = createFileRoute("/skills")({
  validateSearch: (raw: Record<string, unknown>): SkillsSearch => ({
    ...(typeof raw.project === "string" && raw.project ? { project: raw.project } : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q } : {}),
  }),
  component: SkillsPage,
});
