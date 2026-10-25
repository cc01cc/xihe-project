import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a host-root source value against the project (A03 checkout) root.
 *
 * Source values may be relative (`.env.dev`, CLI flags, stack descriptors).
 * The value injected into a Runtime process must be absolute; consumers that
 * run a long-lived process should use `value` from this helper.
 *
 * An empty/blank value is returned as `value: ""` so callers can fail closed.
 */
export function resolveHostRoot(projectDir, raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { value: "", wasRelative: false };
  }
  const wasRelative = !isAbsolute(text);
  return {
    value: wasRelative ? resolve(projectDir, text) : resolve(text),
    wasRelative,
  };
}
