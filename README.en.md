# dsh-context-relay

> Long tasks without drift: keep the context sharp, ask only what must be asked, and stay on course.

[中文](README.md) · [npm](https://www.npmjs.com/package/dsh-context-relay) · [Changelog](CHANGELOG.md) · MIT

**Context-relay plugin for DSH (DeepSeek Harness)**: offers one production mode from v0.9.0: **接力模式（Relay）· 超长任务** (id `relay-long`). The classic `relay` id is a migration alias with identical behavior; compatibility is removed in v0.10.0. It does not swap the model or delete history; it changes how long sessions are organised: when to compact, when to start a fresh session, how to hand over, and what should be decided by you.

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
- The same question is not asked twice; answers you give are remembered and carried into the handover;

### 3. Long and complex tasks stay on track

- Work moves through five phases: understand → decide → build → verify → deliver;
- Each next phase has entry conditions and every phase has completion criteria, so changing the goal mid-way is harder;
- Hitting a context line is only the gate for whether to switch phase; it never interrupts current work;
- Before delivery, a reviewer with a brand-new context independently checks requirement versus implementation, so the agent cannot simply vouch for itself.

### 4. With the official agent team: a two-layer setup, one step further

- In the single production mode the Lead only splits, dispatches and verifies work while teammates build, spreading context pressure across two layers;
- A teammate whose context is dirty can be wiped in place (a true reset) or replaced under a new identity, while the work record is kept;
- When the Lead itself crosses the line, it hands over to a new session: running teammates and background jobs of the old session tree are interrupted, and the new session rebuilds the team and its work memory from the handover and progress documents (it does not take over the old team in place);
- Both layers stay in their efficient range for a long time, raising the ceiling of long tasks;
- The Lead does not spin waiting for teammates after dispatching: their reports arrive as messages, so it only waits once when genuinely blocked and keeps working otherwise (saves tokens). Repeated `relay_team_status` reads with an unchanged team are refused, and a phase switch automatically returns a teammate triage (keep / checkpoint / reset-reuse / renew).

## Single mode and migration

| Mode | Good for | What it does |
|---|---|---|
| **接力模式（Relay）· 超长任务** | Especially long, complex, split-friendly work | The Lead dispatches instead of editing code; teammates can be wiped or replaced, so long tasks last longer |

The single mode stays human-gated: no autonomous loop, no automatic approval on your behalf.

Teams default to 4 members, reused first and expanded as needed up to deployment `maxActiveSubagents`; queue or report blockage at capacity. Every dispatch brief needs five fields: goal / 1–3 must-read pointers with when/role / write scope / acceptance / report path. **Dispatch execution work first**: the Lead's execution ratio targets ≤20% (warn only, never a hard refusal; strict reserved for v0.10.0).

## Design documents

Publishable design summaries for repository readers (the internal point-by-point design log and audit records are not published):

- [Design (DESIGN)](docs/design/DESIGN.md): positioning, the seven design goals, boundaries, key design points and acceptance criteria.
- [Migration (MIGRATION)](docs/design/MIGRATION.md): v0.9.0 normalization actions and read-only fallbacks, and what v0.10.0 removes.

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
8. Create a new session: the mode picker should now show **接力模式（Relay）· 超长任务** (a migration alias may also appear); after selecting it, a status bar should appear above the composer. Both together mean the install succeeded.
9. Optional: the `dsh-context-relay` config card on the Plugins page sets the watermark basis and panel defaults.

**Troubleshooting**

- No modes after install → make sure the bundle is enabled, the profile was reloaded and the page was refreshed; **a successful install does not by itself activate the module**.
- No status bar → it only appears in relay sessions; sessions created before the reload keep the old way of running — create a new session.
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

After installing, restart/reload the profile, refresh the page and create a new relay session.

## What you get

- One production mode: **接力模式（Relay）· 超长任务** (`relay-long`); classic is an identical migration alias, removed in v0.10.0.
- A **status bar** above the composer (relay sessions only): how much context is used, whether a line was reached, which mode is active; click it to open the panel.
- Once work items are recorded, a **ledger chip** appears next to it: `ledger 3/8` = open items / total (an amber dot for in-progress, a red dot for blocked); click it to open the full **work ledger panel**.
- In the panel you can:
  - choose what happens at the line — ask me / continue / compact and continue / hand off; new roots default to compact and continue, explicit choices stay local, and neither modes nor authorizations carry across handoff;
  - give auto-authorisations for compact, hand off, or just the next operation (no approval prompt while enabled);
  - turn on budget unlimited: the agent receives the line your token budget is unlimited, so it dares to spend (prompt text only, not a kernel quota);
  - see what the model suggests (advice only, never executed automatically).
- At a line you get a status notice (not a user message): it reports state and reminds to finish the current phase first, without interrupting.
- The single mode includes teammate management: team status, checkpoints, in-place wipe, and renewal.

### Screenshots

Historical panel screenshot: v0.9.0 removes the next-session mode switch and uses only the four-position dial (ask me / continue / compact / hand off).

![Relay panel](https://github.com/rezon-aki/dsh-context-relay/blob/main/docs/images/relay-panel.png?raw=true)

## Day to day

1. Pick **接力模式（Relay）· 超长任务** when creating a session, then make requests as usual.
2. The agent advances phase by phase: compacts when due, hands off when due, asks when it should.
3. At a line it follows the mode you chose in the panel; with no choice (ask me), it asks you first.
4. For manual control just say so, e.g. compact now, hand off to a new session, or ask me this time.
5. If you ignore a line notice, nothing bad happens — keep giving instructions; it will not compact or hand off on its own.

## Reports, authorizations and capacity preservation

- User reports (including user_gate.report) follow four suggested sections: Conclusion / Impact / What you need to do / Evidence locations (up to 3 pointers). Default ≤600 characters; when the user explicitly requests details, details_requested:true permits expansion, suggested ≤4000 characters. Format and length produce warnings only, returned with phase results and a one-time notice; they never block ship or any phase. Non-empty review/report remain required.
- Do not paste command output, logs or long diffs; explain unfamiliar terms in plain language on first use.
- Authorization is bound to session + operation + schema version, never inherited and invalidated by handoff/version changes. Choosing a mode never grants approval. Only non-authorization architect settings carry over; new roots default to compact and continue.
- Any phase can exit to blocked/cancel with exit_reason, preserving history and the user gate. Resume the prior phase; verify→build allows repairs, and ship requires verify. Timed-out or unfinished reviews never count as passed; continue the review or use a new reviewer.
- The only mid-phase exception is capacity preservation at known-window usage ≥85%: finish the current action, stop new work/dispatch, write brief/progress/ledger, and prepare authorized compaction/handoff. No automatic action; a budget band alone is not an exception.

## Injection and result size (v0.9.0 batch 4)

- **P1 injection dedup**: the ledger focus line is injected only when the focus text changes (rev-only changes do not count); "[context]" appears only when the band/boundary action changes (a line notice already carries it); "[closed loop]" is reported once per signature; "[teammates]" only for a new teammate or a band rise; at most one notice per step (line/boundary wins) and one aggregate after a restart. Dispatch decision points interrupt only on the first dispatch or a band/status change; later dispatches in the same state pass directly.
- **P2 result summarization**: a successful `relay_phase` now returns a human-readable `text` (and `render` returns it), with fixed prefix lines (`phase:/budget:/ledger:/team:/user_gate:/warnings:/lessons:/next:/hint:/summary:`); the structured fields stay (PTC/tests can still read them) and only the `goal`/`exit_criteria` echo is gone.
- **P3 resident protocol dedup**: each rule has a single source of truth (the PROTOCOL base); the ROUTER / teammate-refresh / ledger sections keep only summaries and pointers (§Phase 状态机 / §派活与回执 / §队友保鲜). Root resident injection drops from 12,572 to 11,324 characters (−9.9%); contract clauses (acceptance gate / P0 / minimum attention / batched questions / authorization source) are kept verbatim.

## The work ledger: the current phase's work queue

Execution state, dependencies and acceptance belong to the official task board. The ledger only references `officialTaskId` and records Lead management actions; it does not copy execution state. Overflow and removed done items are archived in `<session>-archive.ndjson`; results expose archive.path/count.

Long tasks drift: the agent forgets what it set out to do and how far it got. The ledger turns "what this phase must finish" into a queue and puts it in front of the agent at the right moments — **event-driven, not time-based**:

- **Register points when a phase opens**: `relay_phase({phase, items:["…","…"]})` records 1–8 points (single-thread work: `items: []`); new items belong to the current phase by default, and a cross-phase item must be carried explicitly;
- **Closed-loop recording**: the current point and its next action are injected as one line ("[ledger·build 2/4] doing「…」next「…」") only when the **focus text changes** (a rev-only change does not count); after a file/command change with no ledger update the agent is prompted "[closed loop] the last change is not recorded" (once per signature); completing a point suggests the next one;
- **Phase-close notice**: unfinished points of this phase should be closed (done with evidence / blocked with a reason) or explicitly carried; the default is a `warn` notice (`workItemsPhaseGate` can be `strict`/`off`; single-thread work declares empty items);
- **Context without memory**: the same batch also carries "[context] band=…" (only when the band/boundary action changes; a line notice already covers it) and "[teammates] pending N: …" (only for a new teammate or a band rise) — the Lead's band and which teammate needs a checkpoint/wipe/renew are right there; at most one notice per step (line/boundary wins), one aggregate after a restart; the snapshot survives compaction and restarts;
- **Read the state before every dispatch and let the Lead decide**: before the Lead sends a task to an idle teammate (`send_message`), the plugin reads that teammate's band/status and returns one decision point on the **first dispatch or a band/status change** (the message is not sent) — over the line or unreadable: (1) manage first (have it `relay_checkpoint`, then `relay_freshen({reset:true, brief})` to reuse the same member with a clean context, 0 quota; renew only for an identity change) and dispatch again; (2) dispatch directly — resending the same call passes, that is the Lead's call. Later dispatches in the same band/status pass directly. A busy teammate is only blocked when over the line or unreadable — ordinary coordination messages pass; if ignored, the phase boundary reminds once more (a warning, never a refusal);
- **Fields**: id (short slug), title, status (open/doing/blocked/done), owner, next action, blocked reason, evidence, acceptance criterion, dependencies, phase;
- **Storage**: `.scratch/context-relay/work-items/<session>.json` (session-level and Leader-only: one per root session; a handoff copies it to the new session), maintained with `relay_work_items`;
- **Reconciliation**: at handoff, open items automatically become the new session's next actions (up to 8); compaction briefs include an open-items section; entering the delivery phase requires every item to be done or blocked;
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
| `threshold` / `settings.threshold` | 35 | Watermark basis (%): a warning 5 points earlier, the basis line suggests handling, 10 points above is the hard line. |
| `settings` | six-field defaults | Initial sidebar defaults; values you save in the UI win. |
| `thresholds` | 0.35 / 0.40 / 0.50 | Legacy thresholds, used only when no UI settings exist. |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | Overrides for the panel/settings file paths. |
| `architect` | `true` | Default for the dedicated-architect switch (the composer "architect" pill overrides it per session; relay-long only). |
| `workItems` | `true` | Enable the work ledger (tool + gates + panel); `false` fully restores the old behaviour. |
| `workItemsGate` | `'strict'` | Ledger check strength for the **delivery (ship) phase**: `strict` (refuse) / `warn` (report only) / `off`. Handoff and compaction always write the ledger into their material and only warn on a corrupt file (fail-open); they are not affected by this key. |
| `workItemsPhaseGate` | `'warn'` | **Phase-close** notice: unfinished points not closed or carried → `warn` proceeds with a notice (default) / `strict` refuses the switch / `off`. Single-thread work declares `items: []`. |
| `delegationGate` | `'warn'` | **build→verify delegation gate**: `warn` reports only and never refuses (default) / `off` disables it; `strict` is normalized to `warn` in v0.9.0 (reserved, enabled in v0.10.0). It checks the session-wide Lead execution ratio >20% (at least 10 tool calls) and build/verify points owned by the Lead without `lead-exec:` evidence; it never blocks the switch. |
| `workItemsPath` | `(per-session by default)` | Override for the ledger file path: an explicit value makes all sessions share one file (the old workspace-level behaviour); the default is `.scratch/context-relay/work-items/<session>.json`. |
| `workItemsMax` | `30` | Item cap (1–100). |
| `injectBrief` | `true` | Whether the handover page is put back into the conversation after compaction. |
| `handoffApproval` | `'required'` | Compaction/handoff must pass the official approval; deployments without an approval UI may set `'off'` (risk accepted by the deployment). |
| `inheritOnHandoff` | `true` | The next session inherits the old model route and permission profile; `false` returns to deployment defaults. |
| `presetId` / `longPresetId` | `relay` / `relay-long` | Legacy alias ID / single mode ID; legacyPresetCompat defaults to true, compatibility removed in v0.10.0. |

Sidebar settings (human-editable, hot-reloaded): watermark basis + default mode / auto decide / auto compact / auto handoff / budget unlimited.

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

| Tool | Purpose |
|---|---|
| `relay_status` | Read current context usage, line state, phase, budget headroom and advice. |
| `relay_phase` | Declare or switch phase; validates entry conditions and the self-check; delivery requires an independent review and a report. |
| `relay_organize` | Write the handover page (with automatic documentation check and key-file index) → official compaction → inject the page back (with a re-read-when-needed reminder). At most once per session by default; when the human sets the panel mode to compact and continue, a second compaction runs as the human chose (approval still applies); without a panel mode the second one needs an explicit human request (`force`). |
| `relay_handoff` | Produce a handover summary plus the full handover file (including the rolling progress file and the work ledger), create a new relay session and clean up the old session tree. Oversize content is never refused: the summary is injected, the full content stays on disk and is fetched on demand. |
| `relay_work_items` | Read or maintain the Leader work ledger: no args = read; the Lead replaces the whole list (optional `rev` optimistic lock); teammates/subagents cannot read or write it. |
| `relay_recommend` | Lead only: write the model advice into the panel (cleared on phase switch, compaction, handoff or human choice). |
| `relay_dispatch` | Lead only: take a ledger point → reuse or spawn a worker → send the standard 5-field brief (goal / 1–3 must-read pointers / write scope / acceptance / report) → mark the ledger item doing with owner+next. Refuses incomplete briefs; returns worker/reportPath/dispatchId. |
| `relay_collect` | Lead only: bounded wait ≤120s → read only the receipt head (task/revision/verdict) + digest (≤600 chars) → mark the ledger item done (evidence=report path) or blocked (reason); returns only the digest, the full report stays in the report file. |
| `doc_lint` | Documentation check (quota / banned wording / index / git / relay session docs), output at most 2KB; quota and size are advisory only. |
| `relay_doc` | Session-document layers and index: `index` (L0 index) / `list` / `read` (by section or line range) / `search` (path:line snippets) / `lint` (advisory). Read the index first, then fetch only the minimal context you need. |

**接力模式（Relay）· 超长任务** includes team tools: `relay_team_status`, `relay_renew`, `relay_architect`, `relay_dispatch`, `relay_collect` (Lead) and `relay_checkpoint`, `relay_freshen` (teammates). The architect model is chosen in the composer model menu ("Architect model / Architect effort" rows; defaults to the composer model selector's default selection, keeps an explicit choice, allows overrides anytime, and inherits the choice on handoff).

HTTP (available only behind the local GUI authentication): `GET/PUT /context-relay/settings`, `GET/PUT /context-relay/panel`, `GET /context-relay/architect-models?sessionId=` (architect model catalog filtered by the session allowlist), `GET /context-relay/work-items?sessionId=` (work ledger for the panel poller).

## Safety boundaries and costs

- **Approval**: compaction and handoff need your go by default; exemptions come only from the panel auto-authorisations (compact / handoff / just the next operation). The panel mode itself only decides what to do and never grants an exemption.
- **Teams and subagents**: from DSH 0.2.2-rc.2 a teammate is itself a subagent-tree member, so relay no longer distinguishes "open a subagent" from "use a teammate"; subagent creation belongs to the official tools.
- **A handoff creates a new session and consumes quota**: it interrupts running teammates and background jobs of the old session tree and migrates scheduled jobs; the old session is marked as handed off for audit.
- **Compaction is lossy**: old conversation detail survives only in that handover page; put important conclusions into documents.
- **No autonomous loop**: relay stays human-gated; use the official Ralph / workflow / subagent for repetitive bulk work.
- **Irreversible actions**: external, paid, credential or delete actions are reported first and need an explicit go; the plugin never auto-approves them.

## Known limitations

- Sessions created before a plugin reload keep the old way of running; new behaviour applies to relay sessions created after the reload.
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

v0.9.0 normalizes compress-then-handoff to null (ask me), autoChoose/autoDecision to false/null, and accepts but ignores handoffPreset. Old panel.json moves to schemaVersion 2 and invalidates authorization. Legacy thresholds still work with a migration warning; classic aliases and these compatibility paths are removed in v0.10.0. Workspace-ledger fallback sync keeps the source; legacy team records remain read-only.

Uninstall unregisters presets, skills, HTTP routes, tools, projections and sentinels. User panel.json/settings.json and workspace .scratch/context-relay/** remain readable. Back up and remove selected data manually if desired; the plugin never deletes it automatically.

## Development

```console
npm test        # node --test test/*.test.mjs
npm run check   # syntax checks for every entry point
```

No build step: host and client are hand-written ESM. Hot-inject for development; ship as a bundle via `cordis.patch.yml`.

`lib/policy.js` (pure policy functions), `lib/panel-store.js` (panel state), `lib/agent.js` + `lib/agent/*` (preset plane), `lib/index.js` (host plane / HTTP), `lib/client.js` (Web UI bundle), `lib/preset-base.js` (PTC preset assets), `skills/` (bundled skills).

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
