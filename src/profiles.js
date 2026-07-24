export const PROFILES = {
  technical: {
    id: "technical",
    label: "Technical correctness",
    deterministic_weight: 0.8,
    judgment_weight: 0.2,
    require_deterministic: true,
    require_judgment: false,
    requirements: [
      "Hidden behavior checks should execute outside the candidate workspace.",
      "Critical assertions must test observable behavior, not identifier names.",
      "Build and test failures must remain visible as candidate failures."
    ]
  },
  visual: {
    id: "visual",
    label: "Visual quality",
    deterministic_weight: 0.3,
    judgment_weight: 0.7,
    require_deterministic: true,
    require_judgment: true,
    requirements: [
      "Capture the same viewports and UI states for every condition.",
      "Use human or calibrated multimodal review for visual quality.",
      "Do not treat screenshot similarity as a quality score."
    ]
  },
  "behavioral-ui": {
    id: "behavioral-ui",
    label: "Behavioral UI reliability",
    deterministic_weight: 0.7,
    judgment_weight: 0.3,
    require_deterministic: true,
    require_judgment: true,
    requirements: [
      "Exercise recovery sequences through the rendered boundary.",
      "Test stale responses, retries, uncertainty, and persistence explicitly.",
      "Preserve visual scope while scoring actionability and accessibility."
    ]
  },
  writing: {
    id: "writing",
    label: "Writing and research",
    deterministic_weight: 0.2,
    judgment_weight: 0.8,
    require_deterministic: false,
    require_judgment: true,
    requirements: [
      "Check required facts and citations deterministically when possible.",
      "Blind reviewers to condition and randomize candidate order.",
      "Keep factuality separate from style preference."
    ]
  },
  generic: {
    id: "generic",
    label: "Generic artifact",
    deterministic_weight: 0.5,
    judgment_weight: 0.5,
    require_deterministic: false,
    require_judgment: false,
    requirements: [
      "Define observable success before running the benchmark.",
      "Use at least one independent evidence source.",
      "Explain any unmeasured quality dimension."
    ]
  }
};

export function resolveProfile(profile) {
  if (typeof profile === "string") return PROFILES[profile] ?? null;
  if (!profile || typeof profile !== "object") return null;
  const base = PROFILES[profile.extends ?? "generic"];
  if (!base) return null;
  return {
    ...base,
    ...profile,
    requirements: profile.requirements ?? base.requirements
  };
}
