import tseslint from "typescript-eslint";

/**
 * C4 — the ratchet. Two review rounds measured the `as any` count staying flat
 * between focused passes because nothing mechanically pushes back. Policy:
 *
 *  - no-unused-vars: ERROR everywhere (dead code found by the round-2 audit
 *    was fixed in this same PR; `_`-prefixed args/vars are the opt-out).
 *  - no-explicit-any: WARN in prod code, OFF in tests. The ratchet is the
 *    per-package `--max-warnings` cap in each lint script: any NEW `any`
 *    pushes the count over the cap and fails CI. Lower the caps as debt is
 *    paid down — never raise them without a tracking note.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "**/coverage/**",
      "claude-plugin/server/**",
      "**/test-results/**",
      "**/.deeppairing/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Dead code is an error, full stop.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // The ratchet target (see header). Count capped per-package via CLI.
      "@typescript-eslint/no-explicit-any": "warn",
      // Codebase idiom: intentional empty catches carry a comment; the rule
      // can't read comments, and the pattern is pervasive + deliberate.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Tests exercise boundaries and fixtures — `any` is fine there.
    files: ["**/__tests__/**", "**/*.test.*", "**/e2e/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
