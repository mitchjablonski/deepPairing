# deepPairing — Architecture & Risk Assessment

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER'S BROWSER                              │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    deepPairing Web App (React + Vite)          │ │
│  │                                                                │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │ │
│  │  │  Research    │  │  Decision    │  │  Code Editor         │ │ │
│  │  │  Dashboard   │  │  Tree View   │  │  (CodeMirror 6)      │ │ │
│  │  │             │  │  (React Flow)│  │  - Annotated diffs   │ │ │
│  │  │  - Findings │  │  - Branch    │  │  - Inline reasoning  │ │ │
│  │  │  - Evidence │  │  - Compare   │  │  - Comment threads   │ │ │
│  │  │  - Citations│  │  - Navigate  │  │  - Accept/reject     │ │ │
│  │  └─────────────┘  └──────────────┘  └──────────────────────┘ │ │
│  │                                                                │ │
│  │  ┌──────────────────────┐  ┌────────────────────────────────┐ │ │
│  │  │  Option Comparison   │  │  Agent Activity Stream         │ │ │
│  │  │  - Side-by-side      │  │  - Real-time tool calls        │ │ │
│  │  │  - Tradeoff matrix   │  │  - Progress indicators         │ │ │
│  │  │  - Human selection   │  │  - Interrupt/redirect controls │ │ │
│  │  └──────────────────────┘  └────────────────────────────────┘ │ │
│  │                                                                │ │
│  │  State: Zustand + Immer (immutable snapshots for branching)   │ │
│  │  Agent Workflows: XState (state machines for session lifecycle)│ │
│  └────────────────────────────────────────────────────────────────┘ │
│         │                                    ▲                      │
│         │ HTTP/WebSocket                     │ SSE (streaming)      │
└─────────┼────────────────────────────────────┼──────────────────────┘
          │                                    │
          ▼                                    │
┌─────────────────────────────────────────────────────────────────────┐
│                    deepPairing API Server                            │
│                    (TypeScript + Hono)                               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    SESSION ORCHESTRATOR                       │   │
│  │                                                              │   │
│  │  ┌─────────────────┐  ┌──────────────────────────────────┐  │   │
│  │  │ Session Manager  │  │ Streaming Parser                 │  │   │
│  │  │                 │  │                                  │  │   │
│  │  │ - Create/resume │  │ - Parse stream-json events       │  │   │
│  │  │ - Fork at       │  │ - Classify: text / tool_call /   │  │   │
│  │  │   decision pts  │  │   tool_result / thinking         │  │   │
│  │  │ - Track lineage │  │ - Emit structured UI events      │  │   │
│  │  │ - GC old        │  │ - Detect agent state (reading/   │  │   │
│  │  │   sessions      │  │   writing/running/thinking)      │  │   │
│  │  └─────────────────┘  └──────────────────────────────────┘  │   │
│  │                                                              │   │
│  │  ┌─────────────────┐  ┌──────────────────────────────────┐  │   │
│  │  │ Decision Engine  │  │ Approval Gate                    │  │   │
│  │  │                 │  │                                  │  │   │
│  │  │ - Classify risk │  │ - Low risk: auto-approve         │  │   │
│  │  │ - Record        │  │ - Med risk: approve + flag       │  │   │
│  │  │   decisions     │  │ - High risk: BLOCK → present     │  │   │
│  │  │ - Build DAG     │  │   decision UI → wait for human   │  │   │
│  │  │ - Track         │  │ - Timeout: configurable per-risk │  │   │
│  │  │   downstream    │  │ - Default action on timeout      │  │   │
│  │  └─────────────────┘  └──────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    HOOK HANDLER                               │   │
│  │                                                              │   │
│  │  Receives all PreToolUse / PostToolUse events from Agent SDK │   │
│  │                                                              │   │
│  │  On PreToolUse:                                              │   │
│  │    1. Classify risk level (read=low, edit=med, bash=varies)  │   │
│  │    2. Log to event store                                     │   │
│  │    3. If high-risk: BLOCK, push to approval queue            │   │
│  │    4. If low-risk: ALLOW, stream event to UI                 │   │
│  │                                                              │   │
│  │  On PostToolUse:                                             │   │
│  │    1. Capture result                                         │   │
│  │    2. Update decision tree state                             │   │
│  │    3. Stream result to UI                                    │   │
│  │                                                              │   │
│  │  ⚠️  CONSTRAINT: Hooks have 60s timeout (configurable)       │   │
│  │  ⚠️  Human approval must complete within timeout window      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    MCP SERVER                                 │   │
│  │                    (@modelcontextprotocol/sdk)                │   │
│  │                                                              │   │
│  │  Exposes tools that Claude can call:                         │   │
│  │                                                              │   │
│  │  deepPairing:present_findings                                │   │
│  │    → Agent calls this after research phase                   │   │
│  │    → Returns structured findings for UI rendering            │   │
│  │                                                              │   │
│  │  deepPairing:request_decision                                │   │
│  │    → Agent calls this at decision points                     │   │
│  │    → Blocks until human responds via UI                      │   │
│  │    → Returns selected option + human reasoning               │   │
│  │                                                              │   │
│  │  deepPairing:present_options                                 │   │
│  │    → Agent calls with 2-3 approaches + tradeoffs             │   │
│  │    → UI renders comparison view                              │   │
│  │    → Returns human's selection                               │   │
│  │                                                              │   │
│  │  deepPairing:log_reasoning                                   │   │
│  │    → Agent explains WHY it's doing something                 │   │
│  │    → Stored in decision DAG, shown as annotations            │   │
│  │                                                              │   │
│  │  ⚠️  CONSTRAINT: Claude treats MCP tools like any tool —     │   │
│  │  no guarantee it calls them without strong prompting         │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                          │                                          │
│                          │ Agent SDK (TypeScript)                   │
│                          │ Spawns Claude Code as subprocess         │
│                          ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    CLAUDE CODE SESSION                        │   │
│  │                    (via Agent SDK query())                    │   │
│  │                                                              │   │
│  │  System prompt includes:                                     │   │
│  │    - deepPairing collaboration instructions                  │   │
│  │    - "Always use deepPairing:present_options at decisions"   │   │
│  │    - "Always use deepPairing:log_reasoning before changes"   │   │
│  │    - Project context (CLAUDE.md)                             │   │
│  │    - User preferences learned over time                      │   │
│  │                                                              │   │
│  │  Built-in tools: Read, Edit, Bash, Grep, Glob, WebSearch    │   │
│  │  MCP tools: deepPairing:* (from our MCP server)             │   │
│  │  Hooks: PreToolUse, PostToolUse, Stop (from our handler)    │   │
│  │                                                              │   │
│  │  Config:                                                     │   │
│  │    max_turns: 50 (loop guard)                                │   │
│  │    max_budget_usd: 2.00 (cost guard)                         │   │
│  │    output_format: stream-json                                │   │
│  │                                                              │   │
│  │  ⚠️  CONSTRAINT: ~12s startup overhead per new session       │   │
│  │  ⚠️  CONSTRAINT: ~8-12 internal API calls per agent turn     │   │
│  │  ⚠️  CONSTRAINT: Auto-compaction is opaque and destructive   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    POSTGRESQL (Neon)                          │   │
│  │                                                              │   │
│  │  events          — Append-only event log (all actions)       │   │
│  │  decisions       — Decision DAG nodes                        │   │
│  │  decision_edges  — Parent→child relationships in tree        │   │
│  │  sessions        — Session metadata + forking lineage        │   │
│  │  annotations     — Human comments on agent work              │   │
│  │  user_prefs      — Learned autonomy preferences              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Interaction Flow: The Three Phases

```
PHASE 1: GATHER                    PHASE 2: PRESENT                   PHASE 3: EXECUTE
(Agent works, human watches)       (Human decides, agent waits)       (Agent executes decision)

┌─────────────────────────┐   ┌──────────────────────────────┐   ┌─────────────────────────┐
│                         │   │                              │   │                         │
│  Agent receives task    │   │  Agent calls MCP tool:       │   │  Agent implements       │
│  via system prompt      │   │  deepPairing:present_options │   │  selected approach      │
│         │               │   │         │                    │   │         │               │
│         ▼               │   │         ▼                    │   │         ▼               │
│  Agent uses built-in    │   │  Backend receives structured │   │  Each tool call flows   │
│  tools to research:     │   │  options data, pushes to UI  │   │  through hooks:         │
│  - Read (explore code)  │   │         │                    │   │  - Low risk: auto       │
│  - Grep (find patterns) │   │         ▼                    │   │  - High risk: approve   │
│  - Bash (run analysis)  │   │  UI renders comparison view: │   │         │               │
│  - WebSearch (docs)     │   │  ┌────────┬────────┐        │   │         ▼               │
│         │               │   │  │Option A│Option B│        │   │  Changes streamed to    │
│         ▼               │   │  │        │        │        │   │  UI as annotated diffs  │
│  All tool calls stream  │   │  │Pros:   │Pros:   │        │   │  with reasoning from    │
│  to UI via hooks →      │   │  │  ...   │  ...   │        │   │  deepPairing:log_reason │
│  "Agent Activity" panel │   │  │Cons:   │Cons:   │        │   │         │               │
│         │               │   │  │  ...   │  ...   │        │   │         ▼               │
│         ▼               │   │  └────────┴────────┘        │   │  Human can:             │
│  Agent calls MCP tool:  │   │         │                    │   │  - Accept changes       │
│  deepPairing:present_   │   │         ▼                    │   │  - Edit inline          │
│    findings             │   │  Human selects option,       │   │  - Comment/annotate     │
│  (triggers Phase 2)     │   │  optionally adds reasoning   │   │  - Redirect agent       │
│                         │   │         │                    │   │  - Branch to explore    │
│                         │   │         ▼                    │   │    alternative           │
│                         │   │  MCP tool returns selection  │   │                         │
│                         │   │  to agent (triggers Phase 3) │   │                         │
└─────────────────────────┘   └──────────────────────────────┘   └─────────────────────────┘

         │                              │                              │
         ▼                              ▼                              ▼
   Hook: PostToolUse             MCP: Blocking call              Hook: PreToolUse
   streams to UI                 waits for human                 gates execution
   (fire-and-forget)             (up to timeout)                 (allow/deny/ask)
```

---

## Session Branching Model

```
                        Session A (main)
                             │
                    Agent researches...
                             │
                    Presents 3 options
                             │
                   Human selects Option B
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Session A      Session A-1     Session A-2
         (continues     (fork: what     (fork: what
          with B)        if we chose     if we chose
                         Option A?)      Option C?)
              │              │              │
         Implements B   Implements A    Implements C
              │              │              │
              ▼              ▼              ▼
         Human reviews  (background)   (background)
         main path      available for   available for
                        comparison      comparison

IMPLEMENTATION:
  - "Fork" = new query() call with same session history + different user message
  - Each fork runs in a SEPARATE git worktree (avoids file conflicts)
  - Fork results stored in DB for comparison UI
  - Human can "adopt" a fork as the new main path
```

---

## Risk Assessment & Mitigations

### RISK 1: Hook Timeout on Human Approval (CRITICAL)

**The Problem:**
Hooks have a 60-second default timeout. If a human takes >60s to review and approve a
high-risk action, the hook times out. The agent either proceeds without approval or
fails — neither is acceptable.

**Severity:** Critical — breaks the core collaboration loop

**Mitigations:**
```
Option A: MCP-based blocking (RECOMMENDED)
  Instead of using hooks to block, have the AGENT call an MCP tool
  (deepPairing:request_decision) that blocks on the server side.
  The MCP tool handler holds the request open (long-poll) until the
  human responds via the UI. No hook timeout issue.

  Flow: Agent calls MCP tool → server holds → human responds via UI →
        server returns to agent → agent proceeds

  Risk: Agent may not always call the MCP tool when we want it to.
  Mitigation: Strong system prompt instructions + hook as fallback.

Option B: Extend hook timeout
  Set hook timeout to 300s+ for approval-required hooks.
  Risk: Blocks the entire agent for 5+ minutes. Expensive (context held in memory).

Option C: Deny-and-requeue
  Hook immediately denies the action. Backend queues the denied action.
  When human approves, a new agent turn is started with "proceed with X."
  Risk: More complex; agent may lose context between denial and re-approval.

RECOMMENDATION: Option A (MCP-based) as primary, Option C as fallback.
```

### RISK 2: Claude Not Calling MCP Tools Reliably (HIGH)

**The Problem:**
Claude treats MCP tools like any other tool — it decides when to call them based on
its own judgment. If Claude doesn't call `deepPairing:present_options` at decision
points, the collaboration breaks.

**Severity:** High — degrades to a standard autonomous agent

**Mitigations:**
```
1. STRONG system prompt:
   "CRITICAL: Before making ANY architectural decision or code change that
    affects more than one file, you MUST call deepPairing:present_options
    with at least 2 alternatives. Before ANY code change, call
    deepPairing:log_reasoning explaining your approach."

2. Hook-based enforcement:
   PreToolUse hook for Edit/Write checks if deepPairing:log_reasoning
   was called recently. If not, DENY the edit and return a message:
   "You must explain your reasoning before making changes."

3. Dual-path approach:
   Use MCP tools as the HAPPY PATH. Use hooks as the ENFORCEMENT LAYER.
   If the agent tries to edit without presenting options first, the hook
   blocks it and reminds it to call the MCP tool.

4. Prompt engineering iteration:
   This will require significant testing. Budget 2-3 weeks of prompt
   tuning to get Claude to reliably follow the collaboration protocol.

RECOMMENDATION: Dual-path (MCP + hook enforcement). Test extensively.
```

### RISK 3: Session Startup Latency (MEDIUM)

**The Problem:**
~12 seconds to start a new Agent SDK session. Each turn involves 8-12 internal API
calls. This creates noticeable latency at every interaction.

**Severity:** Medium — hurts UX, doesn't break functionality

**Mitigations:**
```
1. Keep sessions warm:
   Don't create a new session per interaction. Keep a long-running session
   and send new prompts via resume(). Startup cost is paid once.

2. Optimistic UI:
   Show the agent "thinking" animation immediately. Stream partial results
   as they arrive. The UI should never feel frozen.

3. Pre-warm sessions:
   When user opens a project, pre-create a session in the background
   with project context loaded. By the time they type, it's ready.

4. Background forks:
   When forking for exploration, run forks in background. User continues
   with main session. Forks populate comparison UI when done.

RECOMMENDATION: Warm sessions + optimistic UI. Budget for 2-5s per turn.
```

### RISK 4: Context Compaction Losing Decisions (HIGH)

**The Problem:**
Auto-compaction is opaque and destructive. In a long session, early decisions
and their reasoning may be summarized away. The agent "forgets" why it chose
approach B over A.

**Severity:** High — undermines decision continuity, a core feature

**Mitigations:**
```
1. External decision store (PRIMARY):
   Every decision is persisted to PostgreSQL immediately via MCP tool
   or hook. The agent's context window is NOT the source of truth for
   decisions. The database is.

2. Decision injection on compaction:
   Register a PreCompact hook that captures critical context. After
   compaction, inject a summary of key decisions back into the session.
   
   PreCompact hook → read decision DAG from DB → format as concise
   summary → inject as system context for next turn.

3. Short session strategy:
   For complex tasks, prefer MANY short sessions over ONE long session.
   Each session gets a briefing from the decision store.
   
   Session 1: Research → decisions stored in DB
   Session 2: "Based on these decisions [from DB], implement..."
   Session 3: "Review implementation against these decisions [from DB]..."

4. Context budget monitoring:
   Track token usage per session. When approaching 60% of context limit,
   proactively start a new session with a decision summary.

RECOMMENDATION: External decision store + short session strategy.
The DB is the brain, not the context window.
```

### RISK 5: Concurrent Sessions on Same Codebase (MEDIUM)

**The Problem:**
File locking bugs and git race conditions when multiple sessions touch the
same files. Branching exploration requires parallel sessions.

**Severity:** Medium — breaks branching feature if unmitigated

**Mitigations:**
```
1. Git worktrees for forks:
   Each exploration branch runs in a separate git worktree.
   
   main session → works in /project
   fork A → works in /project-worktree-a (git worktree add)
   fork B → works in /project-worktree-b (git worktree add)
   
   No file conflicts. Each session has its own filesystem.
   Comparison UI diffs the worktrees.

2. Sequential main session:
   Only ONE session modifies the main worktree at a time.
   Forks are read-only analysis or operate on worktree copies.

3. Job queue serialization:
   Use BullMQ to serialize write operations to the same directory.
   Multiple sessions can READ in parallel; WRITES are queued.

RECOMMENDATION: Git worktrees for forks. This is clean and well-understood.
```

### RISK 6: Cost at Scale (MEDIUM)

**The Problem:**
$0.10-$1.00 per agent turn. A session with 20 turns = $2-20. With the
collaboration loop (more turns due to human steering), costs could be higher
than autonomous agents.

**Severity:** Medium — affects pricing model and margins

**Mitigations:**
```
1. Tiered model usage:
   - Research/reading: Use Haiku ($0.25/$1.25 per MTok) for information gathering
   - Decisions/planning: Use Sonnet for option generation
   - Complex reasoning: Use Opus only when needed
   
   Most turns DON'T need Opus. A smart router saves 60-80% on costs.

2. Aggressive caching:
   Prompt caching (automatic in Agent SDK) reduces repeat context costs.
   Cache hit = 90% discount on input tokens.

3. Short, focused sessions:
   Instead of one 50-turn session, run 5 × 10-turn sessions.
   Each session gets a focused brief from the decision store.
   Less context accumulation = lower cost per turn.

4. Pass-through pricing:
   Price deepPairing as $20-40/mo + usage. Let users choose their
   cost/quality tradeoff (Haiku vs Opus).

RECOMMENDATION: Tiered model routing + short sessions. Track cost per
decision, not per session.
```

### RISK 7: Vendor Lock-in (LOW-MEDIUM)

**The Problem:**
Deep dependency on Anthropic's Agent SDK, Claude's behavior, and Anthropic's pricing.

**Severity:** Low-medium — strategic risk, not immediate

**Mitigations:**
```
1. Abstraction layer:
   Define an AgentProvider interface:
   
   interface AgentProvider {
     createSession(config): Session
     query(session, prompt): AsyncStream<Event>
     fork(session): Session
     resume(session, prompt): AsyncStream<Event>
   }
   
   Implement ClaudeAgentProvider first. Could add OpenAIProvider later.

2. MCP is a standard:
   MCP (Model Context Protocol) is becoming an industry standard.
   Our MCP server works with any MCP-compatible agent, not just Claude.

3. Decision store is portable:
   The decision DAG, event log, and annotations are in PostgreSQL.
   They're OUR data, not Claude's. Switching agents doesn't lose history.

4. Prompt-level abstraction:
   Keep collaboration instructions in configurable templates, not
   hardcoded. Different agents may need different prompting styles.

RECOMMENDATION: Build the abstraction layer from day 1. It's cheap
insurance and enforces good architecture.
```

---

## What We Build vs. What We Get for Free

```
┌─────────────────────────────────────────────────────────────────┐
│                        WE BUILD                                  │
│                                                                  │
│  ✦ Research Dashboard UI          ✦ Decision Tree visualization │
│  ✦ Option Comparison panels       ✦ Annotated diff viewer       │
│  ✦ Approval Gate UI               ✦ Agent Activity stream       │
│  ✦ Session Orchestrator           ✦ Hook Handler                │
│  ✦ MCP Server (decision tools)    ✦ Streaming Parser            │
│  ✦ Decision Engine + DAG store    ✦ Risk classifier             │
│  ✦ Context injection on compact   ✦ Cost router (model tier)    │
│  ✦ Git worktree manager           ✦ AgentProvider abstraction   │
│                                                                  │
│  EFFORT: ~80% of engineering time                                │
│  VALUE:  This IS the product — the collaboration UX              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      WE GET FOR FREE                             │
│                      (from Claude Code Agent SDK)                │
│                                                                  │
│  ✦ File system tools (Read, Edit, Write, Glob, Grep)           │
│  ✦ Bash execution (sandboxed)                                   │
│  ✦ Web search & fetch                                           │
│  ✦ Code analysis & understanding                                │
│  ✦ Session persistence & resumption                             │
│  ✦ Token streaming                                              │
│  ✦ Prompt caching                                               │
│  ✦ Subagent orchestration                                       │
│  ✦ MCP protocol support                                         │
│  ✦ Extended thinking / reasoning                                │
│  ✦ Permission system (baseline)                                 │
│                                                                  │
│  EFFORT: ~0% (SDK dependency)                                    │
│  VALUE:  Battle-tested agent infrastructure we'd spend           │
│          6+ months building ourselves                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision: Build on Agent SDK?

### YES, with guardrails

The Agent SDK gives us a massive head start on the agent infrastructure so we can
focus on what actually differentiates deepPairing: the collaboration UX. But we must:

1. **Never treat the agent's context as source of truth** — the DB is the brain
2. **Use MCP tools as primary interaction + hooks as enforcement** — dual-path
3. **Build the AgentProvider abstraction from day 1** — hedge vendor risk
4. **Design for short sessions** — avoid context compaction problems
5. **Use git worktrees for parallel exploration** — avoid file locking issues
6. **Budget 2-3 weeks for prompt engineering** — getting Claude to reliably follow
   the collaboration protocol is the hardest integration challenge
7. **Monitor costs obsessively** — per-decision cost tracking, model tiering

### The honest tradeoff

| | Build on Agent SDK | Build custom (LangGraph) |
|---|---|---|
| **Time to MVP** | 6-8 weeks | 16-20 weeks |
| **Agent quality** | Excellent (Claude + battle-tested tools) | Good (but unproven custom tooling) |
| **Collaboration control** | Indirect (prompts + hooks + MCP) | Direct (custom code at every step) |
| **Cost per user** | Higher (Claude API pricing) | Lower (can use cheaper models) |
| **Vendor lock-in** | Moderate (Anthropic) | Low (model-agnostic) |
| **Maintenance** | SDK updates may break things | Full ownership, full burden |
| **Branching/forking** | Workaround needed (worktrees) | First-class if designed in |

**The collaboration control tradeoff is the key tension.** With Agent SDK, we influence
Claude's behavior through prompts, hooks, and MCP tools — we don't directly control it.
This is usually fine but occasionally frustrating. With a custom build, we control every
step but spend months building inferior agent infrastructure.

**Recommendation: Start with Agent SDK.** Ship the MVP fast. If the indirect control
becomes a real bottleneck (not just an annoyance), we can build a custom agent layer
later — informed by what we learned about what collaboration actually needs.
