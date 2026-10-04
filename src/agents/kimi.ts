import type { AgentAdapter } from "./types.js";

export const kimi: AgentAdapter = {
  id: "kimi",
  displayName: "Kimi Code",
  binaries: ["kimi"],
  skillDirs: [".agents/skills"],
  followsSymlinks: "unverified",
  invoke: (skill) => `/skill:${skill}`,
  delegate: {
    skill: "kimi-delegate",
    sessionField: "sessionId",
    resumeFlag: "--session",
    resumable: true,
    readOnly: "none",
    effortFlag: null,
    cleanEnv: false,
  },
  quotalensProvider: "kimi",
  envMarkers: ["KIMI_CODE"],
  postInstallNotes: ["kimi-delegate cannot run read-only; Looprch checks git status before and after read-only roles."],
  generatedGlobs: [],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "verified" },
};
