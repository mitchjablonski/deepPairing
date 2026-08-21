/**
 * Q3 (golden hardening) — the check_feedback byte-parity HASHES, and nothing
 * else. They used to sit inline in check-feedback-golden-parity.test.ts, one
 * screen below the scenario fixtures that produce them, which meant a scenario
 * edit and a hash edit could land in ONE diff — the exact shape in which a
 * golden regime stops being a guard and becomes a rubber stamp. Split, the two
 * halves show up as two files in a review and a reviewer can ask "why did both
 * move?".
 *
 * The rules, unchanged:
 *   - Values are sha256 of the VERSION-NORMALIZED prose / JSON.stringify of
 *     structuredContent (see the test file's header for why).
 *   - A hash only moves for a DELIBERATE behavior change, and the move is
 *     annotated inline with what moved it. Never re-pin to make a red test go
 *     green.
 *   - One entry per scenario in the test file's `scenarios` array; the test
 *     asserts the two lists agree so neither can drift out from under the other.
 */
export type CheckFeedbackGolden = { prose: string; struct: string };

export const CHECK_FEEDBACK_GOLDENS: Record<string, CheckFeedbackGolden> = {
  healthy_proceed: { prose: "8b519f1b41c0dd6d65a0a092bd981e011cb48e90d827b736ce6ad78a6a6ccf48", struct: "e2bd0b9559c88cb3a4a6bb303b4b3ce005fdc806e14b52880423527d5ec83736" },
  session_directive_plus_secret_comment: { prose: "3c067c69713b33cc6da5303c3ed93b500c65017ee3aacc48638e65a30acd536c", struct: "81948426b3d8f4463ba562c3a32e4fe7018fdac8b3260df8400b5f1925e75327" },
  spec_questions_and_comments_lanes: { prose: "7724d7ea67ed5e897a3381026641f3f03862fbf908a5f8698fb1054b0401fd74", struct: "970844716010909a4d1ca4db8dc5f01bf0d8b9e4615f39695a1aadba10d54629" },
  changeset_delline_crossfile_review: { prose: "177b5f2e9d46cbaf13a578d0a3a456e09072d3fc997c57db57873e48282236f6", struct: "47cdd41db83a4f65bfddb273f4fa15d870c7bb1d0244b7be30c3e0487a85ca5e" },
  decision_grain_lanes: { prose: "47142a2cbf1bc293b48a63875d81db0080ec1822a4e5c2ec95ea32b5a9030819", struct: "280ce1a9f29e3188a685a2e5c04baed19c94285b4366d718065aa3109c80fd4b" },
  decision_region_optionId: { prose: "162a7e68d53e4e7e2e7f1ba22827cec76f4dc9679447b2914cdf42dd3a0c2bbd", struct: "76cd0c12cdd435c9c222617bcb371b44e36d3fc5a5ce441d44dbb7d7dfbb9754" },
  suggestion_state_machine: { prose: "39ebef78697961ab901ba3dea151657bbf7b6dfd9fafdc0df92d570ba06af62f", struct: "d20ab0f846f419450309357d1b30844e32a40b3f03e1e105ccdac5aabd10db08" },
  // Q3 — DELIBERATE re-pin, PROSE only (the struct drops `suggestedAction` on a
  // busy poll, so it is untouched). This scenario is the round-12
  // self-contradiction in miniature: an approved changeset carrying a late
  // follow-up QUESTION used to read "Answer the 1 open question first (reply
  // with answer_question). You may proceed with implementation." — an
  // obligation and its own negation in one sentence. "You may proceed" is now a
  // FALLBACK emitted only when no lane owes anything, so the trailing clause is
  // gone and the question stands alone.
  followup_on_approved: { prose: "c9ccdce587617acbb657522779842ddd7870441b1d2dff06e240272b98082bd1", struct: "6a2e15c5b446c698ce5d7c65b501615ce3b9e003da405b96e965fe7e18b2ec66" },
  // #209 (J1) — DELIBERATE re-pin. Resolving a decision now advances its
  // backing artifact draft→approved store-side (the human PICKED an option =
  // approval), so check_feedback honestly reports the status change alongside
  // the selection. This matches what the PRODUCTION /api/decisions route
  // already did (it flipped the artifact to approved after resolveDecision);
  // the old golden under-modeled that end-to-end path by seeding via the
  // store's resolve alone, which pre-J1 left the artifact stranded in draft.
  resolved_decision_verdict: { prose: "922d5c8e1ca6cce2c0b9c5d984b6e4be72fbc8c7fc6901824c5e5d630151ebfe", struct: "1435cfa7ecaf585b68c45f060180611b71d5665132449945dfee01e2c0790b0a" },
  // Q3 — DELIBERATE re-pin, STRUCT only. The plan verdict lane gained its
  // structuredContent mirror (`planVerdicts`), closing the N1 prose-only gap;
  // the "Plan reviews:" prose is byte-identical, and the verdict here is
  // `approved` so the suggested action is untouched.
  plan_verdict_and_status_change: { prose: "1168802c54dedd2053a9540b75c0e0781130a5613a6c0fa3a5bbd5fcee811659", struct: "a35eccc842134e3b47e681636c5a5f0a4f189c666005dbb7cb7610dd2dc2d2e8" },
  rejected_artifacts: { prose: "2c6c6c46465869df2603d0a58f09cc6c406809743dd8022ebf4db1557c0c3214", struct: "5b7f19c3cd653f6b7f2a130f56f7bc360f11b435dc5ab709e80d036fa51bb2d5" },
  // Q3 — DELIBERATE re-pin, PROSE only (busy poll → the struct carries no
  // `suggestedAction`). The body told the agent to "Fix the Mermaid source and
  // re-present the affected visual" while the Suggested action line said "You
  // may proceed with implementation." A broken diagram the human is staring at
  // is now one of the blocking lanes.
  render_failures: { prose: "4795b9dde556c86db3a122dcc418924d2b1be23bab575371abb1e546ce491e7f", struct: "741a170e295d6aad143c82a15af79f9663b6e0b96d8f2070dbbca58393d26e14" },
  scoped_wait_still_waiting: { prose: "42908de755d8a870009d285ed377c227e274ef5acdece5ec1c7959d50b51fc65", struct: "3fdcaf7107f306723a8d731c2c0484a09a172aa22cc4473fd4998950df2d47ce" },
  debrief_grain_and_ask_anything: { prose: "d3436c950b83aca46b9f494ef58bde9ffbffd40a29b29e9efb6177c57b42bf85", struct: "72dee06f32b6e37afd6ecba2b88ee7b88ae1aae3dec1147532456c64c9e795e0" },
  // P3 — DELIBERATE re-pin, PROSE **and** STRUCT. A draft EXPLAINER is
  // acknowledge-only (its UI footer is "Got it"/"Ask more" — no verdict), so:
  //   - PROSE: it left the "⏳ WAITING: N artifact(s) still under review" nag
  //     for its own "📖 TO READ" line, and the preamble's pending tally drops
  //     it (0 pending, not 1).
  //   - STRUCT: it left PENDING_DRAFT_TYPES entirely, so `pendingArtifacts` no
  //     longer carries it and `status` is no longer "waiting" on its account.
  //     Reporting it as pending while telling the agent not to block on it was
  //     the contradiction that batch was fixing; the same removal lands on the
  //     daemon badge + the web banner (parity-pinned in create-daemon.test.ts
  //     and lib/__tests__/pending.test.ts).
  // This is the ONLY golden scenario carrying a draft explainer.
  //
  // Q3 — re-pinned again, BOTH surfaces, for two deliberate changes:
  //   - PROSE: the open ask-anything question no longer trails "You may proceed
  //     with implementation." (the fallback-not-base fix; same class as
  //     followup_on_approved).
  //   - STRUCT: the 📖 TO READ line gained its `toRead` mirror, so a
  //     structured-only client can finally see the unread explainer that
  //     `pendingArtifacts` deliberately omits.
  explainer_grain_and_ask_anything: { prose: "2d3927ac8573c0e0a11ed99335366e95b59ad7ca119cd84111727d34366d1532", struct: "c3e9898a40fee2f4e3e694efccab6d63470afd59f7cd9d8f0c26ff9b952624c1" },
  debrief_per_item_grain: { prose: "bb0995c0e54d14c13fd6e1d5fdf1b70fa740b86391f55926ae577dc659ba322a", struct: "c9ab6cc8a184bf7242d296f379f4952036472f27fd3393b4ec7da9e28e9c110b" },
};
