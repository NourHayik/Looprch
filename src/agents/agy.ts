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
    writeFlags: ["--dangerously-skip-permissions"],
    printTimeoutFlag: "--print-timeout",
    authFromModels: true,
  },
  quotalensProvider: "antigravity",
  envMarkers: ["ANTIGRAVITY_AGENT"],
  postInstallNotes: [
    "Headless Antigravity runs need one prior interactive login (run `agy` once).",
    "Antigravity write roles (Implementer, Tester) run with --dangerously-skip-permissions: headless agy cannot prompt, so tool permissions are auto-approved (full access). Read-only roles stay in agy's sandbox.",
  ],
  generatedGlobs: [],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "not_run" },
};
