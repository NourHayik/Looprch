import type { AgentAdapter } from "./types.js";

export const agy: AgentAdapter = {
  id: "agy",
  displayName: "Antigravity",
  binaries: ["agy"],
  skillDirs: [".agents/skills"],
  followsSymlinks: "unverified",
  invoke: (skill) => `/${skill}`,
  delegate: {
    skill: "agy-delegate",
    sessionField: "conversationId",
    resumeFlag: "--conversation",
    resumable: true,
    readOnly: "best-effort",
    effortFlag: "--effort",
    cleanEnv: false,
  },
  quotalensProvider: "antigravity",
  envMarkers: ["ANTIGRAVITY_AGENT"],
  postInstallNotes: ["Headless Antigravity runs need one prior interactive login (run `agy` once)."],
  generatedGlobs: [],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "not_run" },
};
