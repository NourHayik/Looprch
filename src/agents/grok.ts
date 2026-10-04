import type { AgentAdapter } from "./types.js";

export const grok: AgentAdapter = {
  id: "grok",
  displayName: "Grok Build",
  binaries: ["grok"],
  skillDirs: [".grok/skills"],
  followsSymlinks: "unverified",
  invoke: (skill) => `/${skill}`,
  delegate: {
    skill: "grok-delegate",
    sessionField: "sessionId",
    resumeFlag: "--session",
    resumable: true,
    readOnly: "best-effort",
    effortFlag: "--effort",
    cleanEnv: false,
  },
  envMarkers: ["GROK_SESSION"],
  postInstallNotes: ["Grok Build ignores project skills until you trust the folder in Grok.", "Grok support is experimental until its verification spikes run."],
  generatedGlobs: [],
  verified: { skills: "not_run", invoke: "not_run", direct: "not_run", resume: "not_run", readOnly: "not_run" },
  experimental: true,
};
