/**
 * P1 (round-11), F14 — the guardrail backstop's ZERO-I/O prefilter, alone in a
 * tiny module.
 *
 * Two consumers, for two different reasons:
 *   - both PreToolUse hook copies use it to decide whether the guardrail
 *     evaluation is worth paying for at all, BEFORE any file read (and, on the
 *     init-generated path, before the dynamic import of the matcher core);
 *   - setup-tasks.ts INTERPOLATES the literal into the generated .mjs, so the
 *     init-path copy and the plugin-bundled copy share one definition by
 *     construction rather than by hand-maintenance.
 *
 * It lives here rather than in preflight-hook-core.ts so setup-tasks.ts (which
 * the CLI loads on every `init` / daemon startup) imports ~20 lines instead of
 * dragging the whole hook core — and its matcher — into the cold start.
 *
 * Deliberately LOOSE: it matches nested occurrences the authoritative
 * root-relative matcher rejects. A false positive costs one cheap evaluation,
 * never an ask; a false NEGATIVE would silently disable the backstop, so the
 * parity test asserts it is a strict superset of every guardrail rule.
 */
export const GUARDRAIL_PATH_PREFILTER =
  /(^|\/)(\.github\/workflows|\.circleci|\.gitlab-ci|Jenkinsfile|migrations|db\/migrate|prisma\/migrations|supabase\/migrations|alembic\/versions|Dockerfile|docker-compose|compose|infrastructure|terraform|k8s|kubernetes|helm|\.env|config\/secrets|config\/credentials|config\/master\.key)(\/|\.|$)|\.tfvars$/;

/** True when the tool_input's target path could plausibly be a guardrail path.
 *  Windows separators normalized so the same literal works on both platforms. */
export function looksLikeGuardrailPath(toolInput: unknown): boolean {
  try {
    const input = toolInput as { file_path?: unknown; filePath?: unknown } | null;
    const fp = input?.file_path ?? input?.filePath;
    if (typeof fp !== "string" || !fp) return false;
    return GUARDRAIL_PATH_PREFILTER.test(fp.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}
