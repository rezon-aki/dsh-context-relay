# dsh-context-relay

> Long tasks without drift: keep the context sharp, ask only what must be asked, and stay on course.

[中文](README.md) · [npm](https://www.npmjs.com/package/dsh-context-relay) · [Changelog](CHANGELOG.md) · [Migration](docs/design/MIGRATION.md) · MIT

**Context-relay plugin for DSH (DeepSeek Harness)**: one production mode only: **接力模式（Relay）· 超长任务** (id `relay-long`). v0.10.0 is the "complete form" delivery: a two-stage user gate (design gate + implementation-to-design alignment), a declarative agent plane, official seam contracts with visible degradation, and a single persistence layer; the old dual-mode presets and every compatibility path are removed (see the [migration guide](docs/design/MIGRATION.md)). It does not swap the model or delete history; it changes how long sessions are organised: when to compact, when to start a fresh session, how to hand over, and what should be decided by you.

## The problems it solves

In one line:

1. The session context stays inside its efficient range, so long tasks do not drift apart;
2. Human interaction gets more efficient — the agent knows which questions should come to you;
3. Long and complex tasks keep their bearings;
4. Paired with the official agent team, a two-layer setup pushes long-task capability one step further.

### 1. Keep the session context inside its efficient range

The longer a conversation runs, the more an agent forgets, repeats and over-builds. The plugin sets watermarks for the session:

- Before a line is reached, the agent first writes down what a successor needs to know: goal, settled decisions, evidence, next step;
- Then it compacts the old conversation and puts that page back in, so the work continues without a break;
- At a harder line, the work moves to a brand-new session and the old one stays as an audit record;
- Compaction happens at phase boundaries, never mid-work; extra instructions and skills that get tucked away come with a reminder to re-read them when needed.

The result: a long task no longer depends on saying everything at once — it keeps moving inside a bounded memory.

### 2. Better human interaction: the agent knows which questions are yours to decide

The test is simple: would it change the outcome, the boundaries or the cost? If yes, ask the human; if no, find out first.

- Facts the agent can check itself get checked; only real decisions come to you, and chores do not interrupt you;
- Questions lead with the conclusion and impact, then options (recommended + default + consequence), then wait for one word from you;
- Irreversible, external, paid, credential or delete actions stop first with a plain-language note of what, why and how to roll back, and wait for an explicit yes;
- The same question is not asked twice; answers you give are remembered and carried into the handover.

### 3. Long and complex tasks stay on track

- Work moves through five phases: understand → decide → build → verify → deliver;
- Each next phase has entry conditions and every phase has completion criteria, so changing the goal mid-way is harder;
- Hitting a context line is only the gate for whether to switch phase; it never interrupts current work;
- Before work starts there is a design gate (design confirmed by you first); before delivery a reviewer with a brand-new context independently checks requirement versus implementation, so the agent cannot simply vouch for itself.

### 4. With the official agent team: a two-layer setup, one step further

- In the single production mode the Lead only splits, dispatches and verifies work while teammates build, spreading context pressure across two layers;
- A teammate whose context is dirty can be wiped in place (a true reset) or replaced under a new identity, while the work record is kept;
- When the Lead itself crosses the line, it hands over to a new session: running teammates and background jobs of the old session tree are interrupted, and the new session rebuilds the team and its work memory from the handover and progress documents (it does not take over the old team in place);
- Both layers stay in their efficient range for a long time, raising the ceiling of long tasks;
- The Lead does not spin waiting for teammates after dispatching: their reports arrive as messages, so it only waits once when genuinely blocked and keeps working otherwise (saves tokens).

## Single mode and upgrade

| Mode | Good for | What it does |
|---|---|---|
| **接力模式（Relay）· 超长任务** | Especially long, complex, split-friendly work | The Lead dispatches instead of editing code; teammates can be wiped or replaced, so long tasks last longer |

The single mode stays human-gated: no autonomous loop, no automatic approval on your behalf.

Teams default to 4 members, reused first and expanded as needed up to deployment `maxActiveSubagents`; queue or report blockage at capacity. Every dispatch brief needs five fields: goal / 1–3 must-read pointers with when/role / write scope / acceptance / report path. **Dispatch execution work first**: the Lead's execution ratio targets ≤20% (`delegationGate` defaults to `warn` — a notice only; the `strict` tier can be configured and refuses the switch on a hit).

**v0.10.0 is a breaking release**: the classic `relay` alias, dual-mode config, cth/autoChoose/autoDecision/handoffPreset, legacy thresholds, `next_operation` and every other compatibility path are removed; the panel authorization contract moves to version 3 (old authorizations expire once). Read the [migration guide](docs/design/MIGRATION.md) before upgrading.

## Two-stage user gate (v0.10.0)

Two alignment points before delivery, neither of them self-certified by the implementer:

1. **Design gate (before work starts, an explicit stop)**: hand the design (architecture / change surface / acceptance / risks) to the user for confirmation; after confirmation, the first entry into build must carry `design_gate{path, user_approved:true}` (the path of the user-approved design document). Without it `relay_phase` refuses with zero side effects.
2. **Implementation-to-design alignment (during work / acceptance)**: before declaring done (ship), a model in a **fresh context** performs one independent review (requirement ↔ implementation: drift / degradation / laziness / gaps), in parallel with other acceptance work, not as a serial final gate; the conclusion goes into `user_gate.review` and then a plain-language `user_gate.report` is given to the user (both non-empty hard gates; no approval popup).
3. **Acceptance is minimal by default**: target-module tests + a single independent diff review + (when needed) one syntax/static check. Heavy verification (full suite / real machine end-to-end / large sampling / multiple review rounds / cross-environment matrix / performance tests) is not done by default and needs explicit user approval (`user_gate.verification{tier:'heavy', approved_by_user:true}`, otherwise refused).
4. **`contract_check` is required only at ship** (requirements settled / faithful implementation / attention self-check); optional elsewhere.

## Design documents

Publishable design summaries for repository readers (the internal point-by-point design log and audit records are not published):

- [Architecture (ARCHITECTURE)](docs/design/ARCHITECTURE.md): layers and file placements, the 9 official seam contracts and degradation, agent-plane reconcile, persistence/policy/notice layering, phase↔ledger contracts (v0.10.0).
- [Design (DESIGN)](docs/design/DESIGN.md): positioning, the seven design goals, boundaries, key design points and acceptance criteria.
- [Migration (MIGRATION)](docs/design/MIGRATION.md): breaking changes from 0.8.x to v0.10.0, upgrade/rollback steps and retained data.

Usage lives in this README; per-release behavior changes are in [CHANGELOG.md](CHANGELOG.md).

## Install

Requires DSH `>=0.2.2-rc.2` (this kernel generation only) and Node.js `>=20`. Verified on DSH 0.2.2-rc.2: preset rows follow the official ptc patch; team features (status/renew/architect) adapt to the subagent tree; the work ledger is Leader-only and teammates do not read or write it.

### Option A (recommended): DSH Web UI sidebar Plugins

Everything stays in the Web UI — no command line needed:

1. Open the DSH Web UI and click **Plugins** in the left sidebar.
2. Click **Add plugin** in the top-right. (The arrow next to it opens the Choose how to add a plugin menu; **Install third-party plugin** leads to the same dialog.)
3. In the install dialog, fill **Package name** with `dsh-context-relay` (append `@<version>` to pin one). The dialog also accepts Git URLs, tarballs and absolute local paths.
4. Leave **Install source** at its default: on first use it probes the official npm registry and the mainland-China mirror and uses whichever responds first. You can also pick the official npm registry / mainland-China mirror / a custom http(s) URL manually.
5. Click **Install**. The Host first resolves the package and shows its name, one-line description and version; pnpm commands and output stay folded under **View install details**.
6. When installation completes, click **Enable now**. If you closed the dialog, open the `dsh-context-relay` bundle from **Installed plugins** on the Plugins page and switch it on.
7. Follow the prompt to **restart/reload the profile** (profiles with HMR rebuild automatically; otherwise restart `dsh web`), then **refresh the page**.
8. Create a new session: the mode picker should now show **接力模式（Relay）· 超长任务**; after selecting it, a status bar should appear above the composer. Both together mean the install succeeded. **You can also start from the default session and switch**: pick Relay in the mode picker (before the first turn or mid-session) and the plugin backfills the Lead tool surface and trims execution tools (`relay_status.plane` is the self-check).
9. Optional: the `dsh-context-relay` config card on the Plugins page sets the watermark basis and panel defaults.

**Troubleshooting**

- No modes after install → make sure the bundle is enabled, the profile was reloaded and the page was refreshed; **a successful install does not by itself activate the module**.
- No status bar → it only appears in relay sessions; confirm the session preset is Relay (switch it in the mode picker and it takes effect immediately).
- After a plugin upgrade/reload, existing relay sessions are reconciled idempotently (no rebuild needed); if a session still behaves like the old version, switch its preset once or create a new session.
- Updating → uninstall and reinstall to upgrade (this plugin is not an official on-demand bundle, so there is no built-in Update action).

### Option B: command line

```console
dsh plugin --profile web add dsh-context-relay
```

Git and local-directory installs also work:

```console
dsh plugin --profile web add github:rezon-aki/dsh-context-relay
dsh plugin --profile web add /path/to/dsh-plugins/dsh-context-relay
```

After installing, restart/reload the profile, refresh the page and create or switch to a relay session.

## What you get

- One production mode: **接力模式（Relay）· 超长任务** (`relay-long`); the classic alias is gone (old sessions: see the [migration guide](docs/design/MIGRATION.md)).
- A **status bar** above the composer (relay sessions only): how much context is used, whether a line was reached, which mode is active; click it to open the panel. After the v0.10.0 upgrade the panel/sidebar tells you when a session's authorization needs to be re-enabled (old authorizations expire once).
- Once work items are recorded, a **ledger chip** appears next to it: `ledger 3/8` = open items / total (an amber dot for in-progress, a red dot for blocked); click it to open the full **work ledger panel**.
- In the panel you can:
  - choose what happens at the line — ask me / continue / compact and continue / hand off; new roots default to compact and continue, explicit choices stay local, and neither modes nor authorizations carry across handoff;
  - give auto-authorisations for compact, hand off, or just the next operation (no approval prompt while enabled);
  - turn on budget unlimited: the agent receives the line "your token budget is unlimited", so it dares to spend (prompt text only, not a kernel quota); the Lead's setting is inherited by the teammates / architects / dispatch workers it creates (written to the child session panel at spawn), and an existing teammate reusing its session via `relay_freshen` (or an architect continued via `relay_architect`) syncs to the Lead's current value;
  - see what the model suggests (advice only, never executed automatically).
- At a line you get a status notice (not a user message): it reports state and reminds you to finish the current phase first, without interrupting.
- The single mode includes teammate management: team status, checkpoints, in-place wipe, and renewal. Teammates are **not polled**: an unchanged repeated status query is refused, reports arrive as messages, and a phase switch returns a teammate triage (keep / checkpoint / reset-reuse / renew).

### Screenshots

Historical panel screenshot (the current dial is ask me / continue / compact / hand off only):

![Relay panel](https://github.com/rezon-aki/dsh-context-relay/blob/main/docs/images/relay-panel.png?raw=true)

## Day to day

1. Pick **接力模式（Relay）· 超长任务** when creating a session (or switch to it afterwards), then make requests as usual.
2. The agent advances phase by phase: compacts when due, hands off when due, asks when it should.
3. At a line it follows the mode you chose in the panel; with no choice (ask me), it asks you first.
4. For manual control just say so, e.g. compact now, hand off to a new session, or ask me this time.
5. If you ignore a line notice, nothing bad happens — keep giving instructions; it will not compact or hand off on its own.

## Reports, authorizations and capacity preservation

- User reports (including user_gate.report) follow four suggested sections: Conclusion / Impact / What you need to do / Evidence locations (up to 3 pointers). Default ≤600 characters; when the user explicitly requests details, details_requested:true permits expansion, suggested ≤4000 characters. Format and length produce warnings only, returned with phase results and a one-time notice; they never block ship or any phase. Non-empty review/report remain required.
- Do not paste command output, logs or long diffs; explain unfamiliar terms in plain language on first use.
- Authorization is bound to session + operation + schema version, never inherited and invalidated by handoff/version changes. Choosing a mode never grants approval. Only non-authorization architect settings carry over; new roots default to compact and continue. From v0.10.0 the panel authorization contract is version 3: loading an old panel.json expires every session's authorizations once (mode/architect settings are preserved).
- Any phase can exit to blocked/cancel with exit_reason, preserving history and the user gate. Resume the prior phase; verify→build allows repairs, ship requires verify (ship→blocked/cancel can resume to ship). Timed-out or unfinished reviews never count as passed; continue the review or use a new reviewer.
- The only mid-phase exception is capacity preservation at known-window usage ≥85%: finish the current action, stop new work/dispatch, write brief/progress/ledger, and prepare authorized compaction/handoff. No automatic action; a budget band alone is not an exception.

## Injection and result size (v0.10.0)

- **Notice planning/delivery split**: at most one notice per step (line/boundary wins, ≤900 characters); dedup keys are claimed **only after successful delivery**, so a failed injection retries next step; all notice bodies are redacted (credentials never enter session history/UI); `[closed loop]` fires only for tools that actually write files (`write`/`edit`/`apply_patch`) — read-only bash/reconnaissance no longer produces false alarms; a read-only `relay_work_items` call no longer clears the pending marker.
- **Compaction reset**: after an official auto-compaction (`compactionSeq` rises) the line band is re-armed and focus/closed-loop/boundary dedup keys are cleared — reminders that should fire still fire.
- **Teammate notices never carry the Lead's ledger line** (teammates have no `relay_work_items` tool); when metrics are unavailable (`band=unavailable`) a one-time conservative notice is shown instead of a silent "ok".
- **Result summarisation**: a successful `relay_phase` returns a human-readable `text` (fixed prefix lines `phase:/budget:/ledger:/team:/user_gate:/warnings:/lessons:/next:/hint:/summary:`); structured fields stay; the `goal`/`exit_criteria` echo is gone.
- **Injection budget**: the resident protocol + all 15 tool schemas + assembly snapshots of 4 roles (lead/teammate/architect/worker) are covered by budget assertions, preventing unbounded growth.

## The work ledger: the current phase's work queue

Execution state, dependencies and acceptance belong to the official task board. The ledger only references `officialTaskId` and records Lead management actions; it does not copy execution state. Overflow and removed done items are archived in `<session>-archive.ndjson`; results expose archive.path/count.

Long tasks drift: the agent forgets what it set out to do and how far it got. The ledger turns "what this phase must finish" into a queue and puts it in front of the agent at the right moments — **event-driven, not time-based**:

- **Register points when a phase opens**: `relay_phase({phase, items:["…","…"]})` registers 1–8 points **only when crossing into a new phase** (single-thread work: `items: []`); new items belong to the current phase by default, and a cross-phase item must be carried explicitly. **Passing `items` again for the same phase is explicitly refused (zero side effects)** — add points with `relay_work_items`.
- **Closed-loop recording**: the current point and its next action are injected as one line ("[ledger·build 2/4] doing「…」next「…」") only when the **focus text changes** (a rev-only change does not count); after a `write`/`edit`/`apply_patch` with no ledger update the agent is prompted "[closed loop] the last change is not recorded" (once per signature); completing a point suggests the next one.
- **Phase-close notice**: unfinished points of this phase should be closed (done with evidence / blocked with a reason) or explicitly carried; `phase=null` entries count too and cannot bypass the strict gate; the default is a `warn` notice (`workItemsPhaseGate` can be `strict`/`off`; single-thread work declares empty items).
- **Context without memory**: the same batch also carries "[context] band=…" (only when the band/boundary action changes; a line notice already covers it) and "[teammates] pending N: …" (only for a new teammate or a band rise) — the Lead's band and which teammate needs a checkpoint/wipe/renew are right there; at most one notice per step (line/boundary wins), one aggregate after a restart; the snapshot survives compaction and restarts.
- **Read the state before every dispatch and let the Lead decide**: before the Lead sends a task to an idle teammate (`send_message`), the plugin reads that teammate's band/status and returns one decision point on the **first dispatch or a band/status change** (the message is not sent) — over the line or unreadable: (1) manage first (have it `relay_checkpoint`, then `relay_freshen({reset:true, brief})` to reuse the same member with a clean context, 0 quota; renew only for an identity change) and dispatch again; (2) dispatch directly — resending the same call passes, that is the Lead's call. Later dispatches in the same band/status pass directly. A busy teammate is only blocked when over the line or unreadable — ordinary coordination messages pass; if ignored, the phase boundary reminds once more (a warning, never a refusal).
- **Fields**: id (short slug), title, status (open/doing/blocked/done), owner, next action, blocked reason, evidence, acceptance criterion, dependencies, phase; the old `next_operation` argument was removed in v0.10.0 — next-step information lives only in the item's `next` field.
- **Storage**: `.scratch/context-relay/work-items/<session>.json` (session-level and Leader-only: one per root session; a handoff copies it to the new session), maintained with `relay_work_items`; the panel's `GET /context-relay/work-items` is strictly read-only (it never triggers legacy data migration writes).
- **Reconciliation**: at handoff, open items automatically become the new session's next actions (up to 8); compaction briefs include an open-items section; entering the delivery phase requires every item to be done or blocked.
- **Panel**: the `ledger 3/8` chip above the composer opens a read-only panel grouped by status; editing always goes through the agent tool.

Without a ledger file nothing changes — it is optional.

## The dedicated architect teammate (relay-long)

In long tasks the expensive failure is "start writing before the route is clear". This mode gives the team a **fixed architect teammate** (always named `architect`; created once and reused):

- **The Lead only does two things**: align requirements with the user (boundaries/acceptance/trade-offs) and read the project docs to understand the business and current state;
- **The architect turns requirements into an engineering route**: it starts every task from a **low context** — reads only the necessary context (the Lead's requirement brief, doc pointers, relevant module entry points) and delivers an engineering implementation document (default `.scratch/context-relay/architecture/<task>.md`: requirement alignment / technical route / module interfaces / data & protocols / risks & trade-offs / open decisions / implementation steps & acceptance). The Lead uses `relay_architect({mode:'fresh'})` for a clean context (the old generation checkpoints first); only continuous low-context work uses `mode:'continue'`; after delivery it only runs `checkpoint` and waits;
- **Decisions that need the user**: the architect writes them into the document's "open decisions" and reports to the Lead; the Lead brings them to you and passes the conclusion back — it never asks you directly and never decides for you;
- **Switch and model**: a small "architect" pill next to the "unlimited budget" pill in the composer (shown only for 接力模式（Relay）· 超长任务) controls whether the Lead hands engineering-route design to the architect (default on). **The model is chosen in the DSH model menu**: open the composer model selector and the official "Model / Effort" rows are followed by "Architect model / Architect effort"; the official menu owns the shell, anchoring, keyboard and focus behaviour, and the list stays open after a choice so you can adjust the effort next. **Explicit overrides are restricted by the official subagent model allowlist**: only models allowed for this session are listed as explicit choices; a session with no recorded allowlist may explicitly select only the Lead's current route (new sessions inherit the allowlist from the settings). **The architect model defaults to the composer model selector's default selection** (the Lead's current default model): an unselected session uses that default without refusing or blocking, and a session's explicit choice is kept. Override it anytime in the "Architect model / Architect effort" rows (explicit overrides must be inside the official subagent model allowlist), or choose "默认（跟随模型选择）" (Default: follow model selection) to restore the default; handoff inherits the choice.

## Configuration

Optional host plugin config (advanced):

| Key | Default | Meaning |
|---|---|---|
| `threshold` / `settings.threshold` | 35 | Watermark basis (%): a warning 5 points earlier, the basis line suggests handling, 10 points above is the hard line. **The only threshold source from v0.10.0**; legacy `config.thresholds` is removed. |
| `settings` | six-field defaults | Initial sidebar defaults; values you save in the UI win. |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | Overrides for the panel/settings file paths. |
| `architect` | `true` | Default for the dedicated-architect switch (the composer "architect" pill overrides it per session; relay-long only). |
| `workItems` | `true` | Enable the work ledger (tool + gates + panel); `false` fully restores the old behaviour (mutually exclusive with the delegation-first protocol; warns at load). |
| `workItemsGate` | `'strict'` | Ledger check strength for the **delivery (ship) phase**: `strict` (refuse) / `warn` (report only) / `off`. Handoff and compaction always write the ledger into their material and only warn on a corrupt file (fail-open); they are not affected by this key. |
| `workItemsPhaseGate` | `'warn'` | **Phase-close** notice: unfinished points not closed or carried (including `phase=null` entries) → `warn` proceeds with a notice (default) / `strict` refuses the switch / `off`. Single-thread work declares `items: []`. |
| `delegationGate` | `'warn'` | **build→verify delegation gate**: `warn` reports only and never refuses (default) / `strict` refuses the switch on a hit (zero side effects) / `off` disables it. It checks the session-wide Lead execution ratio >20% (at least 10 tool calls) and build/verify points owned by the Lead without `lead-exec:` evidence; `warn` never blocks the switch, `strict` refuses build→verify on a hit. |
| `workItemsPath` | `(per-session by default)` | Override for the ledger file path: an explicit value makes all sessions share one file (the old workspace-level behaviour); the default is `.scratch/context-relay/work-items/<session>.json`. |
| `workItemsMax` | `30` | Item cap (1–100). |
| `injectBrief` | `true` | Whether the handover page is put back into the conversation after compaction. |
| `handoffApproval` | `'required'` | Compaction/handoff must pass the official approval; deployments without an approval UI may set `'off'` (risk accepted by the deployment). |
| `inheritOnHandoff` | `true` | The next session inherits the old model route and permission profile; `false` returns to deployment defaults. |
| `longPresetId` | `'relay-long'` | The single mode id (defaults to `presetId` + `-long` when unset; `presetId` defaults to `relay`). The classic alias and `legacyPresetCompat` are removed. |

Sidebar settings (human-editable, hot-reloaded): watermark basis + default mode / auto compact / auto handoff / architect / budget unlimited.

Panel state (per session): persistent local mode (not consumed, never inherited), session-local operation authorizations, budget unlimited, model advice.

Data files: `~/.dsh/data/dsh-context-relay/settings.json` and `panel.json`; conversation content stays stored by DSH itself.

## Document layers and index (v0.8.0)

Cross-session documents are no longer capped by hard byte limits that reject or truncate; they follow the official DSH instruction-file / skill-catalog pattern: an index, layers, and on-demand reads.

- **L0 index**: `relay_doc index` renders an auto-generated index (paths relative to `.scratch/context-relay/`, each entry with "when to read", size and update time); handoff summaries and phase briefs include it automatically. It is derived from content digests and never goes stale.
- **Layers**: L1 = handoff / phase brief / progress / lessons (read first by a new session); L2 = architecture / docs / decisions / research (on demand); reports/archive = raw pointers (via `relay_doc search`). Rule of thumb: must a new session/teammate see it on day one? Yes -> L1, otherwise -> L2.
- **On-demand reads**: `relay_doc read` supports section/line-range reads; `relay_doc search` returns only `path:line` + snippet; `relay_doc lint` is an advisory check (missing frontmatter / broken pointers / oversize / L1 over threshold). Delegation carries a "must read: INDEX + 1-3 docs" list.
- **Caps are advisory**: byte/count limits on handoff / progress / lessons / chain / team no longer reject or drop data — overflow is archived (`*-archive-*.ndjson`, `progress-archive-*.md`) or written in full with a pointer in the message; always-injected content stays bounded.
- **Writing discipline**: durable docs carry frontmatter (`role:`, `layer: L2`, `when:`); run `relay_doc search` before writing to avoid duplicates; never paste long documents into messages — keep details in L2.

## Technical reference: agent tools and HTTP API

15 tools in total: 7 always-on + `doc_lint` + 5 Lead-only + 2 teammate/architect tools. Tool surfaces are trimmed by role: the Lead does not install execution tools (bash/pwsh/write/edit are hidden), teammates do not install Lead-only tools, and ordinary subagents get only a minimal set.

| Tool | Purpose |
|---|---|
| `relay_status` | Read current context usage, line state, phase, budget headroom, dispatch/execution ratio, agent-plane self-check (`plane{role,installed,degradations}`) and advice. |
| `relay_phase` | Declare or switch phase; the first entry into build validates the design gate `design_gate`, delivery requires an independent review and a report + verification tier; warn band needs `budget_plan`. |
| `relay_organize` | Write the handover page (with automatic documentation check and key-file index) → official compaction → inject the page back (with a re-read-when-needed reminder). At most once per session by default; when the human sets the panel mode to compact and continue, a second compaction runs as the human chose (approval still applies); without a panel mode the second one needs an explicit human request (`force`). |
| `relay_handoff` | Produce a handover summary plus the full handover file (including the rolling progress file and the work ledger), create a new relay session and clean up the old session tree. Oversize content is never refused: the summary is injected, the full content stays on disk and is fetched on demand; rc.2 scheduled jobs are migrated by Host-wide target. |
| `relay_work_items` | Read or maintain the Leader work ledger: no args = read; the Lead replaces the whole list (optional `rev` optimistic lock); teammates/subagents cannot read or write it. |
| `relay_recommend` | Lead only: write the model advice into the panel (cleared on phase switch, compaction, handoff or human choice). |
| `doc_lint` | Documentation check (quota / banned wording / index / git / relay session docs), output at most 2KB; quota and size are advisory only. |
| `relay_doc` | Session-document layers and index: `index` (L0 index) / `list` / `read` (by section or line range) / `search` (path:line snippets) / `lint` (advisory). Read the index first, then fetch only the minimal context you need. |
| `relay_dispatch` | Lead only: take a ledger point → reuse or spawn a worker → send the standard 5-field brief → mark the ledger item doing with owner+next. Refuses incomplete briefs; returns worker/reportPath/dispatchId (persisted as the receipt freshness authority). |
| `relay_collect` | Lead only: bounded wait ≤120s → read only the receipt head (task/revision/verdict) + digest (≤600 chars) → validate task and dispatchId → mark the ledger item done (evidence=report path) or blocked (reason); returns only the digest, the full report stays in the report file. |
| `relay_team_status` | Lead only: team health/band/checkpoint/dispatch counts/reset result summary; the signature includes the grandchild count so an unchanged repeated query is refused. |
| `relay_renew` | Lead only: replace a teammate generation (only for an identity/role change; the new generation occupies capacity, the old one is disposed). |
| `relay_architect` | Lead only: create or continue the fixed architect (`mode:'fresh'|'continue'`). |
| `relay_checkpoint` | Teammate/architect: write a checkpoint (one-line conclusion/completion/decisions/evidence/constraints/open questions/next actions, ≤4KB advisory). |
| `relay_freshen` | Teammate/architect: in-task compaction (≤2 per generation, lossy); `{reset:true, brief}` truly wipes the context and installs a new brief (same member, no quota); both success and failure are reported to the teammate via a notice. |

**接力模式（Relay）· 超长任务** includes team tools: `relay_team_status`, `relay_renew`, `relay_architect`, `relay_dispatch`, `relay_collect` (Lead) and `relay_checkpoint`, `relay_freshen` (teammates). The architect model is chosen in the composer model menu ("Architect model / Architect effort" rows; defaults to the composer model selector's default selection, keeps an explicit choice, allows overrides anytime, and inherits the choice on handoff).

HTTP (available only behind the local GUI authentication): `GET/PUT /context-relay/settings`, `GET/PUT /context-relay/panel`, `GET /context-relay/architect-models?sessionId=` (architect model catalog filtered by the session allowlist), `GET /context-relay/work-items?sessionId=` (read-only work ledger for the panel poller; no migration-write side effects).

## Safety boundaries and costs

- **Approval**: compaction and handoff need your go by default; exemptions come only from the panel auto-authorisations (compact / handoff / just the next operation). The panel mode itself only decides what to do and never grants an exemption.
- **Official seam contracts with visible degradation**: the 9 official seams (preset/agents/tools/systemPrompt/compaction/projections/schedule/wipe/team) are shape-checked at startup; a kernel shape mismatch degrades to N/A + warn and is recorded in `relay_status.plane.degradations` (no silent fail-open, and sessions are not refused).
- **The PTC program channel is a soft execution constraint (known limitation)**: tool-surface trimming only hides **model tool calls** such as `bash`/`pwsh`/`write`/`edit`; inside `run_code`, `node:fs`, child processes etc. can still write files and read anything — the plugin does **not** guard that channel (settled), relying on protocol discipline, self-checks and receipts; no hard isolation is promised.
- **Teams and subagents**: from DSH 0.2.2-rc.2 a teammate is itself a subagent-tree member, so relay no longer distinguishes "open a subagent" from "use a teammate"; subagent creation belongs to the official tools.
- **A handoff creates a new session and consumes quota**: it interrupts running teammates and background jobs of the old session tree and migrates scheduled jobs; the old session is marked as handed off for audit.
- **Compaction is lossy**: old conversation detail survives only in that handover page; put important conclusions into documents.
- **No autonomous loop**: relay stays human-gated; use the official Ralph / workflow / subagent for repetitive bulk work.
- **Irreversible actions**: external, paid, credential or delete actions are reported first and need an explicit go; the plugin never auto-approves them.

## Known limitations

- **Presets are switchable (from v0.10.0)**: the plugin installs the Lead plane idempotently through four entries — `agent/created` / startup backfill / `agent-preset/selected` / per-step lazy fallback — so "switching requires a new session" is obsolete. If `relay_status.plane.installed=false`, read `degradations` to find the missing seam; if it still misbehaves, switch the preset once or create a new session.
- **The PTC program channel is a soft constraint**: only model tool calls are trimmed; `node:fs`/child-process writes inside `run_code` are not intercepted (see "Safety boundaries and costs"). No channel guard is a settled decision.
- Verified on the DSH Web environment only; headless and other deployments are untested.
- The real benefit of compaction/handoff depends on model and task length; watermarks are not universally optimal.
- Visual details have no automated regression coverage — inspect after installing.
- Compaction fidelity and benefit have no strict A/B; neither do the watermark inflection points.
- A session compacts once by default to avoid summary drift; when the human sets the panel mode to compact and continue, a second compaction runs as the human chose (approval still applies); without a panel mode it needs an explicit human request (`force`).
- If writing the panel state fails it lives in memory only (lost on restart); settings writes are persist-first.
- UI text is Chinese-only; the Chinese docs are the source of truth.
- The work ledger is **session-level and Leader-only**: each relay session has its own ledger; teammates/subagents neither read nor write the Lead ledger, and it is not shown in their UI. Handoff copies it to the new session (`rev` kept). The panel is read-only and edits go through the agent tool; the default cap is 30: overflow first archives done items; only overflow without enough done items is refused. Archive failures leave the ledger unchanged; archive path/count are available, with no automatic deletion.
- Resource reclamation is not promised: the kernel usually auto-releases at natural settlement; relay keeps an internal activation handle only for renewal capacity, and no longer promises memory savings after compaction.
- The team-first gate is removed: from DSH 0.2.2-rc.2 teammates are subagent-tree members, so the plugin cannot distinguish "open a subagent" from "use a teammate".
- The architect model defaults to the composer model selector's default selection, keeps a session's explicit choice, and does not refuse or block when unselected; only explicit overrides must be inside the session's official subagent allowlist.
- Preset rows follow the official 0.2.2-rc.2 ptc patch only; earlier kernels (rc.1 / 0.2.1 series) are no longer supported.

## Upgrade and uninstall

**v0.10.0 is a breaking release** (upgrade directly from 0.8.x): panel.json `schemaVersion` moves to 3, so old session authorizations expire once (auto compact / auto handoff / next-operation authorizations must be re-enabled; mode and architect settings are preserved); the classic `relay` alias, `routerMode`/`legacyPresetCompat`, `config.thresholds`, cth/autoChoose/autoDecision/handoffPreset and `next_operation` on `relay_phase` are all removed; the protocol moves to the two-stage user gate. Open an old classic session and switch it to Relay in the mode picker to backfill its plane. See the [migration guide](docs/design/MIGRATION.md) for the full list and upgrade steps; the old v0.9.0 change log is in [CHANGELOG.md](CHANGELOG.md) (history only).

Uninstall unregisters presets, skills, HTTP routes, tools, projections and sentinels. User panel.json/settings.json and workspace .scratch/context-relay/** remain readable. Back up and remove selected data manually if desired; the plugin never deletes it automatically.

## Development

```console
npm test        # node --test test/*.test.mjs
npm run check   # syntax checks for every entry point
```

No build step: host and client are hand-written ESM. Hot-inject for development; ship as a bundle via `cordis.patch.yml`.

`lib/policy.js` (policy single source), `lib/seams.js` (official seam contracts), `lib/plane/` (role table and idempotent reconcile), `lib/storage.js` (atomic writes/locks), `lib/panel-store.js` (panel state), `lib/agent.js` + `lib/agent/*` (preset plane and tools), `lib/agent/notice/` (notice planning/delivery), `lib/index.js` (host plane / HTTP), `lib/client.js` (Web UI bundle), `lib/preset-base.js` (PTC preset assets), `skills/` (bundled skills).

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
