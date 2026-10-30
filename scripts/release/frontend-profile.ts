/** The explicit district-only build selector. Unset and false retain upstream assets. */
export const SCHOOL_BUILD_ENV = "EDUCATEOS_SCHOOL_BUILD";

/** Resolves the frontend build flags and the manifest variant before any build starts. */
export function frontendProfile(env: NodeJS.ProcessEnv): {
  variant: "access" | "access-school";
  env: NodeJS.ProcessEnv;
} {
  const value = env[SCHOOL_BUILD_ENV];
  if (value !== undefined && value !== "false" && value !== "true") {
    throw new Error(`${SCHOOL_BUILD_ENV} must be true or false`);
  }
  const school = value === "true";
  return {
    variant: school ? "access-school" : "access",
    // Explicit false prevents an inherited VITE flag from silently changing generic releases.
    env: { ...env, VITE_CF_ACCESS_MODE: "true", VITE_EDUCATEOS_SCHOOL_MODE: String(school) },
  };
}

/** Resolve CLI/environment selection once so frontend assets and backend authority cannot diverge. */
export function releaseProfile(env: NodeJS.ProcessEnv, requested?: "generic" | "school") {
  const inherited = frontendProfile(env);
  const selected = requested ?? (inherited.variant === "access-school" ? "school" : "generic");
  if (requested !== undefined && env[SCHOOL_BUILD_ENV] !== undefined &&
      (requested === "school") !== (inherited.variant === "access-school")) {
    throw new Error("--profile conflicts with EDUCATEOS_SCHOOL_BUILD");
  }
  return { profile: selected, ...frontendProfile({ ...env, [SCHOOL_BUILD_ENV]: String(selected === "school") }) };
}
