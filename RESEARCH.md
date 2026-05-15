# deepPairing - Research Brief

> **Note:** This document captures research notes from project inception
> (early 2026). It is not a current architecture spec — see
> [CLAUDE.md](CLAUDE.md) for the shipped design. Some early framings here
> have been refined as the build progressed.

## Executive Summary

There is a clear, underserved gap in the AI developer tools market. The industry has bifurcated into two camps — **full autonomy** (Devin, Copilot Workspace) and **augmented autocomplete** (Copilot, basic Cursor) — while the **collaborative middle** remains relatively underexplored as an intentional product surface. Adjacent tools (Aider's architect mode, Cline, Continue) gesture at this space; deepPairing targets it with a framework where AI gathers information and presents structured decision points, while humans steer, decide, and refine.

### The Core Thesis (Validated by Research)

Current tools operate in a 0/1-shot paradigm: the human provides a prompt, the AI executes, the human reviews output. This skips the dozens of micro-decisions a human would make during implementation. Research confirms:

- Developers make a meaningful decision every **30-60 seconds** during active coding
- They spend **more time gathering context** than any other activity — exactly where AI adds the most value
- AI changes coding from a *writing* task to a *comprehension/verification* task, which is **2-5x harder** cognitively
- The "70% problem" is well-documented: AI gets you 70% fast, but the last 30% takes as long as doing it all manually
- **No existing framework treats collaboration as its core design** — every one starts autonomous and bolts on human interaction

---

## 1. The Problem Space

### What's Broken Today

| Problem | Evidence | Opportunity |
|---------|----------|-------------|
| **Agents go off in wrong direction** | Devin ~15-30% real-world success rate; yak-shaving is the #1 complaint | Human steering at decision points catches wrong turns early |
| **500 lines to review** | Code review effectiveness drops sharply after 200-400 LOC (Microsoft Research) | Present changes with reasoning, at decision-level granularity |
| **No shared mental model** | AI doesn't externalize its understanding; human can't see or correct it | Make AI's understanding visible and correctable |
| **Context loss in long sessions** | Performance degrades after 30+ turns; "lost in the middle" problem | Decision-centric context (structured records, not conversation history) |
| **Black-box reasoning** | All output presented with same confidence; no tradeoff surfacing | Show reasoning, confidence, and alternatives at each decision point |
| **Approval fatigue (Cline model)** | Users report wanting "just do it" for trusted operations | Approve DECISIONS not OPERATIONS — right granularity |
| **Plans disconnected from execution** | Copilot Workspace plans looked good but produced wrong code | Living plans that update as AI discovers new information |

### The Flow State Paradox

This is deepPairing's core design challenge: **more collaboration = more interruptions = less flow**. Research shows:
- Time to reach flow: **10-15 minutes** of uninterrupted focus
- Average recovery after interruption: **10-23 minutes**
- But: self-initiated pauses at natural breakpoints are **minimally costly**

**Resolution:** Batch decisions at natural breakpoints. Use tiered autonomy (auto-execute low-risk, flag medium-risk, block high-risk). Align interruptions with task boundaries.

---

## 2. Competitive Landscape

### The Market Map

```
                    MORE AUTONOMOUS
                         |
              Devin      |     Factory AI
            ($500/mo)    |
                         |
         Copilot         |     Replit Agent
         Workspace       |     Bolt.new
         (pivoted)       |
                         |
    ─────────────────────┼─────────────────────
                         |
         Cursor          |     *** deepPairing ***
         Composer        |     (THE GAP)
                         |
         Cline           |     Aider
         (per-step)      |     (architect mode)
                         |
                    MORE COLLABORATIVE
         
    LESS STRUCTURED ─────┼───── MORE STRUCTURED
```

### Key Competitor Insights

**Cursor** — The market leader. Diff-review UX is table stakes. Rules files show users want to pre-configure AI behavior. But Agent mode is increasingly autonomous (20+ tool calls before showing results). No information gathering phase. No option presentation.

**Cline** — Proves demand for human-in-the-loop, but wrong granularity (approve file reads, not decisions). Approval fatigue is a documented problem.

**Aider** — Architect/editor split validates separating thinking from doing. Git-native workflow is essential. But terminal-only limits UX richness. Plans are chat text, not interactive artifacts.

**Copilot Workspace** — Three-phase model (spec → plan → code) is sound but **pivoted/folded** because plans were too disconnected from implementation. Key lesson: plans must be living documents.

**Devin** — The anti-pattern. Demonstrates exactly why full autonomy fails: yak-shaving, confident incorrectness, context loss. Session replay is useful but insufficient — humans need to steer in real-time.

**v0 by Vercel** — **Presenting 2-3 options with tradeoffs** is their killer insight. This is the interaction pattern deepPairing should adopt for architectural decisions.

### Five Strategic Principles from Competitive Analysis

1. **Separate information gathering → decision-making → execution** (no competitor does all three well)
2. **Present options, don't prescribe** (v0's insight applied broadly)
3. **Make the plan a living artifact** (Copilot Workspace's failure lesson)
4. **Right-size approval granularity** — decisions, not operations (Cline's lesson)
5. **Show reasoning attached to changes** — legal "redline with annotations" model applied to code

### Competitive Moat

Features get copied in months. The moat is:
- **The collaboration methodology** — a well-defined framework, not just features
- **The information presentation layer** — how AI structures research for humans is hard to replicate
- **Community + content** — establish deepPairing as the authority on human-AI collaboration

---

## 3. Design Principles

### From UI/UX Research

1. **Anchor, don't separate.** AI explanations attached to the code they explain (inline annotations, code lens), not in separate panels
2. **Three-level disclosure.** Every AI output: (a) one-line summary, (b) brief rationale, (c) full detail with evidence. Never force all three levels
3. **Tree, not thread.** Model interaction as a branching exploration tree, not linear conversation. Users can jump to any prior state
4. **Collection, not sequence.** Multiple independent suggestions → triageable collection (cards/table), not sequential list
5. **Trace to evidence.** Every AI claim links to evidence (code locations, test results, docs). Inline citations with expandable sources
6. **Interrupt sparingly.** Only interrupt for high-confidence, high-impact items. Everything else → non-interruptive sidebar
7. **Make undo trivial.** Auto-snapshot before AI changes. Cost of trying = near zero
8. **Override with reason.** When developer disagrees, capture why. Builds feedback loop
9. **AI output is immediately editable** — not locked behind accept/reject binary (Notion AI's insight)

### From Adjacent Domains

- **Medical decision support:** Traffic light risk indicators, structured evidence presentation, confidence signals, alert fatigue research (>90% of generic alerts ignored)
- **Legal AI:** Research-then-present model, citation of sources, redline with annotations
- **Chess analysis (Lichess):** Branching exploration tree with evaluation at each node, multiple variations visible
- **Figma:** Contextual comments anchored to specific elements, real-time visibility of collaborator activity
- **Pair programming research:** Navigator/Driver roles with fluid switching. Works because of continuous dialogue, knowledge sharing, and immediate validation

### Developer Trust Factors

**Trust builders:** Predictability, transparency, correctness track record, easy verification, scope limitation, trivial undo

**Trust killers:** Context switching, latency >2s, over-suggestion, lack of control, opaque failures

**Latency budget:** 200ms inline, 2s panel, 10s with progress for complex operations

---

## 4. Architecture

### Core Architectural Pattern

```
┌──────────────────────────────────────────────────────┐
│           FRONTEND (React + Vite)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐         │
│  │ Research  │ │ Decision │ │ Code Editor  │         │
│  │ Dashboard │ │   Tree   │ │ (CodeMirror) │         │
│  └──────────┘ └──────────┘ └──────────────┘         │
│  ┌──────────────┐ ┌──────────────────────┐           │
│  │ Option Panels │ │ Approval/Steering UI │           │
│  └──────────────┘ └──────────────────────┘           │
│         ↕ SSE (streaming)    ↕ WebSocket (collab)    │
├──────────────────────────────────────────────────────┤
│           TYPESCRIPT API LAYER (Hono)                 │
│  Sessions │ Auth │ Streaming Parser │ Persistence     │
│  ┌──────────────────────────────────────────┐        │
│  │ Hook Handler — intercepts every tool call │        │
│  │ MCP Server — exposes decision/approval    │        │
│  │ Session Manager — fork, branch, resume    │        │
│  │ Decision Store — event-sourced state      │        │
│  └──────────────────────────────────────────┘        │
│                    ↕ Agent SDK (programmatic)          │
├──────────────────────────────────────────────────────┤
│           CLAUDE CODE (via Agent SDK)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐         │
│  │ Built-in │ │ MCP Tools│ │  Subagents   │         │
│  │  Tools   │ │  (from   │ │  (parallel   │         │
│  │ Read,Edit│ │deepPair- │ │ exploration) │         │
│  │ Bash,Grep│ │  ing)    │ │              │         │
│  └──────────┘ └──────────┘ └──────────────┘         │
│  Hooks fire on every action → streamed to backend     │
├──────────────────────────────────────────────────────┤
│           POSTGRESQL (Neon)                            │
│  Sessions │ Decision Trees │ Annotations │ Memory     │
└──────────────────────────────────────────────────────┘
```

> **Key change from original architecture:** The Python/LangGraph AI layer is replaced
> by **Claude Code via the Agent SDK**. This gives us all of Claude Code's tools
> (Read, Edit, Bash, Grep, Glob, WebSearch), subagent orchestration, session
> persistence, and streaming — for free. We focus all our effort on the
> collaboration UX, which is the actual differentiator.

### Claude Code Integration Points

| Integration | What It Does | deepPairing Use |
|-------------|-------------|-----------------|
| **Agent SDK** | Programmatic control of Claude Code | Spawn/manage agent sessions from our backend |
| **Hooks** (`PreToolUse`, `PostToolUse`, `Stop`) | Intercept every tool call | Stream actions to UI; custom approval gates |
| **MCP Server** | Expose custom tools to Claude | `deepPairing:present_options`, `deepPairing:request_decision` |
| **Subagents** | Parallel specialized agents | Branch exploration (3 approaches simultaneously) |
| **Sessions** | Persistent, resumable conversations | Fork sessions at decision points; resume across days |
| **stream-json** | Real-time token + event streaming | Parse into React state for live UI updates |
| **Permission rules** | Fine-grained allow/deny per tool | Tiered autonomy (auto low-risk, block high-risk) |
| **Skills/Plugins** | Packaged workflows | `/deepPairing:branch`, `/deepPairing:decide` commands |

### Key Architectural Decisions

**Event-sourced state management** with checkpoint-based branching (git-like DAG for decisions). Every state change — human and agent — recorded as an append-only event log. Gives full history, replayability, and branching.

> *(Inception-era proposal — not the shipped design. The actual implementation uses a per-session JSON file store with append-only audit comments and a separate cross-project Philosophy Ledger. See [CLAUDE.md](CLAUDE.md) for current architecture.)*

**Tiered autonomy model:**
- Low-risk actions → auto-execute (formatting, simple refactors)
- Medium-risk actions → execute + flag for async review
- High-risk actions → block and present decision point
- Risk levels adapt over time based on user behavior

**Decision-centric context management** — not conversation-centric:
- Working memory: current context window
- Short-term memory: recent decisions (structured records)
- Long-term memory: indexed store of all past interactions (semantic search)
- Episodic memory: key moments stored as structured records

**Decision data model:**
```
Decision {
  id, timestamp,
  context_snapshot,        // state when decision was made
  presented_options[],     // what the agent showed
  selected_option,         // what the human chose (or custom)
  human_reasoning?,        // why (optional)
  confidence?,             // how confident
  downstream_effects[],    // what this influenced
}
```

### The Three-Phase Interaction Loop

```
PHASE 1: GATHER              PHASE 2: PRESENT              PHASE 3: EXECUTE
┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│ Agent researches: │    │ Structured findings: │    │ Human-approved   │
│ - Read codebase  │    │ - Options with       │    │ direction:       │
│ - Analyze deps   │───>│   tradeoffs          │───>│ - Code changes   │
│ - Check patterns │    │ - Evidence/citations  │    │ - With reasoning │
│ - Find precedent │    │ - Recommendations    │    │ - Auto-committed │
│ - Run analysis   │    │ - Risk assessment    │    │ - Tests run      │
└──────────────────┘    └──────────────────────┘    └──────────────────┘
        ↑                        ↑                         │
        └────────────────────────┴─────────────────────────┘
                    Human can redirect at any point
```

---

## 5. Recommended Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Frontend** | React + Vite | Ecosystem dominance for specialized components; concurrent rendering for streaming UX |
| **Components** | shadcn/ui (Radix + Tailwind) | Copy-and-own, fully customizable, accessible primitives |
| **Code Editor** | CodeMirror 6 | Built for custom decorations/annotations; lighter than Monaco (~150KB vs ~5MB); better for multiple instances |
| **State** | Zustand + Immer (UI) + XState (agent workflows) | Immutable snapshots for branching exploration; state machines for agent lifecycles |
| **Backend API** | TypeScript + Hono | Shared types with frontend; modern, fast, edge-ready |
| **AI Layer** | Claude Code Agent SDK | Battle-tested agent with all tools built in; hooks, MCP, subagents, streaming, sessions — no reimplementation needed |
| **MCP Server** | TypeScript (@modelcontextprotocol/sdk) | Expose decision/approval tools that Claude Code can call |
| **Database** | PostgreSQL (Neon) | JSONB for semi-structured data; recursive CTEs for trees; serverless with DB branching |
| **Streaming** | SSE (AI output) + WebSockets (collaboration later) | SSE simpler, proxy-friendly; what all LLM APIs use natively |
| **Deployment** | Web app first → Tauri desktop | Max reach, zero install; Tauri ~10MB vs Electron ~150MB |
| **Monorepo** | Turborepo + pnpm workspaces | Fast, cached builds; clean workspace management |
| **Validation** | Zod | Shared schemas between frontend + backend |
| **Testing** | Vitest + Playwright | Fast unit tests + E2E |
| **Graphs/Trees** | React Flow | Decision tree visualization, node-based exploration |

### Monorepo Structure

```
deepPairing/
  apps/
    web/          # React frontend (Vite)
    desktop/      # Tauri wrapper (later)
    api/          # TypeScript API server (Hono) + Agent SDK integration
  packages/
    shared/       # Shared TypeScript types, Zod schemas
    ui/           # shadcn/ui components + custom components
    mcp-server/   # MCP server exposing decision/approval tools to Claude Code
  turbo.json
  pnpm-workspace.yaml
```

### Key Architecture Insight

By using **Claude Code Agent SDK** as the AI layer, we collapse the Python/LangGraph layer entirely. The TypeScript API server spawns Claude Code sessions programmatically, intercepts every tool call via hooks, and streams structured events to the React frontend. Our MCP server exposes deepPairing-specific tools (present options, request decisions, record approvals) that Claude can call natively. This means **100% of our engineering effort goes into the collaboration UX** — the actual differentiator — rather than reimplementing agent infrastructure.

---

## 6. Go-to-Market

### Pricing Model

Target the **$20/mo individual / $40/seat team** sweet spot established by Cursor. Consider:
- Free tier with limited sessions/decisions per month
- Pro $20/mo (unlimited, all models)
- Team $40/seat/mo (shared context, collaboration, admin)
- Enterprise custom (SSO, audit logs, on-prem)

### GTM Strategy

1. **"See the difference" demos** — side-by-side videos: autonomous tool fails (yak-shaving) vs. deepPairing catches the issue early
2. **Developer education content** — "How to pair program with AI effectively" — establish the methodology, then offer the tool
3. **Open-source core** — build trust and community; the collaboration methodology should be transparent
4. **Target persona: senior devs and tech leads** who WANT to stay involved but find current tools too autonomous or too tedious
5. **YouTube/content creator partnerships** — visual demos sell coding tools (Cursor and Bolt.new proved this)

---

## 7. Key Risks

| Risk | Mitigation |
|------|------------|
| **Interruption cost > collaboration value** | Adaptive autonomy; batch decisions at natural breakpoints; tiered risk |
| **Slower than fire-and-forget** | Must FEEL fast even if more thorough; streaming previews; parallel exploration |
| **Context management at scale** | Decision-centric context (not conversation); hierarchical memory |
| **Cold start** | Sensible defaults; quick preference learning; project-level configuration |
| **Features commoditized quickly** | Moat = methodology + community, not features |
| **Complex branching UX** | Start simple (linear decisions); add branching progressively |

---

## 8. What "10x Better" Looks Like

1. **Shared mental model** — AI articulates its understanding; human can correct it
2. **Adaptive autonomy** — learns when to ask vs. proceed based on your patterns
3. **Decision continuity** — close laptop, return tomorrow, pick up with full context
4. **Branching exploration** — "try 3 approaches, show me tradeoffs"
5. **Teaching and learning** — gets better at working with YOU specifically over time
6. **Transparent reasoning** — at every decision point, see why and what alternatives were considered
7. **Minimal interruption cost** — batched questions at natural breakpoints
8. **Graceful degradation** — when uncertain, communicates clearly rather than hallucinating

---

## Sources

### Academic Papers
- Amershi et al., "Guidelines for Human-AI Interaction," CHI 2019
- Barke et al., "Grounded Copilot: How Programmers Interact with Code-Generating Models," OOPSLA 2023
- Vaithilingam et al., "Expectation vs. Experience," CHI 2022
- Sarkar et al., "What is it like to program with artificial intelligence?," 2022
- Mozannar et al., "Reading Between the Lines," 2024
- Liu et al., "Lost in the Middle," 2023
- Horvitz, "Principles of Mixed-Initiative User Interfaces," 1999
- Mark, Gonzalez, Harris, "No Task Left Behind? Examining the Nature of Fragmented Work," CHI 2005

### Industry
- Addy Osmani, "The 70% Problem" (2025)
- Steve Yegge on AI coding tools (2024-2025)
- Williams & Kessler, pair programming research
- Microsoft Research: code review effectiveness, developer productivity
- JetBrains Developer Ecosystem Survey 2024
