# dsh-context-relay

[中文](https://github.com/rezon-aki/dsh-context-relay/blob/main/README.md) | **English**

> **Long sessions degrade. This plugin keeps a Lead agent in its high-efficiency context window** — with a phase protocol, a context sentinel, controlled compaction, and bounded handoffs into a fresh session.

Version 0.3.5 · Requires DSH ≥ 0.2.1-rc.2 · Node.js ≥ 20 · MIT

---

## 1. What it is and what problem it solves

An AI coding session's context is not free. Once a Lead agent's window is roughly a third to 40% full, it starts drifting from the implementation: it loses the thread, re-litigates decisions, over-engineers, and gets slower and less reliable. DSH's built-in compaction does not fix this — it triggers late (around 80% by default), reduces context with a summary, and breaks the prefix cache on the way.

This plugin adds a **Relay mode** (a native agent preset that appears in the mode selector) with five pieces:

1. **Context sentinel** — `relay_status` reports the live pressure of the Lead and every teammate, the current phase, the remaining budget, and a recommendation for the next continue action.
2. **Phase protocol** — work is split into `discover → decide → build → verify → ship`. Budgets act as **phase-boundary gates, never as mid-phase interruptions**: a phase is finished even when its budget band rises; what changes at the boundary is whether you may open another phase, and how (estimate / split / relay). Every phase switch carries a mandatory `contract_check`. `ship` is the acceptance declaration and can only be entered from `verify`, with a fresh-context independent review plus a plain-language report.
3. **Controlled compaction** — `relay_organize` writes a structured phase brief (with a `doc_lint` line and key-document pointers), then calls the official compaction engine once to shrink context into a clean range. The brief is injected after compaction succeeds, so the facts you need survive.
4. **Delegation & receipt discipline in the default Relay protocol** (recommended, not enforced; 2026-11-04): long docs/logs/diffs, file writes and command runs are delegated to teammates/subagents; a worker receipt is a ≤4KB report file plus one ≤200-character message, the Lead only aggregates a ≤600-character digest, and small tasks may still be done directly. Tool availability is unchanged. An **optional second mode "Relay · 超长任务" (Relay · very long tasks)** goes further: the **root Lead** has `bash/pwsh/write/edit` hidden on its own agent layer and only dispatches (teammates are unaffected; a soft guard, not a security boundary) — for sessions expected to run for hours. See the long-mode notes in [CHANGELOG.md](CHANGELOG.md).
5. **Teammate freshness v3 (v0.3.2, 2026-11-07; supersedes the v0.3.0/v0.3.1 wording; Relay · very long tasks only):** teammates write a durable work record with `relay_checkpoint` (≤4KB structured handoff: done/decisions/evidence/constraints/open questions/next actions); `relay_freshen({reset:true})` performs a **true wipe** — same member, same session, no member quota consumed, not counted against the freshen limit — replacing the model-visible surface via DSH surface replacement (system prompt kept), with automatic fallback to official compaction and no false success report; plain `relay_freshen` (official, lossy compaction) is only for in-task pressure relief, at most twice per generation. The Lead inspects `relay_team_status` before assigning work (fresh/watch/stale/spent); `relay_renew` is for identity/role changes only (a new generation consumes one member creation). Records are partitioned per Lead session under `.scratch/context-relay/team/<lead-session-id>/` (roster/checkpoint/ledger/handoffs; pre-partition records are read-only fallback), older sessions are recalled on demand via `session_event_read({session_id, seq})`. When the member quota is exhausted, do not spawn: reuse via reset, or `relay_handoff` to a new Team at a phase boundary then `relay_rehydrate` from the latest non-current partition. DSH's 8 is a per-Team lifetime member-creation cap, not a concurrent-slot limit; this plugin does not change the deployment `maxMembers`. Full-duplex dispatch and watchdog are later phases.
6. **Bounded handoff** — `relay_handoff` writes a size-capped structured handoff and creates a **new top-level relay session** to continue the work. The old session is kept for audit (handedOff), a rolling progress file carries long-term state, and background jobs / teammates / schedules in the old session tree are cleaned up automatically.
7. **Model recommendation (v0.3.3, 2026-11-07)** — the threshold-crossing notice nudges the Lead to call `relay_recommend({operation, reason})` (**Lead-only**: non-root sessions have the tool hidden and the execute path refuses them). The composer popover then shows a "model recommendation" row, the matching dial detent gets a cold-cyan dashed "荐" (recommended) highlight, and the chip title is annotated. **It is advice only** — it never writes the one-shot preset, never executes compaction or handoff, and grants no approval exemption; the human preset/decision still rules. The recommendation is cleared on a successful phase switch, compaction or handoff, and when the human picks an operation in the panel. **v0.3.4 patch:** the long mode has only three operations (continue / compact / hand off) — `relay_recommend` rejects `compress-then-handoff` there (classic keeps it) and a stored long-mode value is treated as continue and cleared; recommendation labels now match the panel detents (compact / hand off) and both the reminder and the panel truncate the reason at 60 chars (storage stays ≤120). **v0.3.5 patch:** a stale long-mode `compress-then-handoff` recommendation from v0.3.3 no longer reaches the host threshold notice (filtered on display and cleared when a long-mode root session is created), the long-mode dial detent count is now consistently worded "4 items (ask me + 3 operations)", and the `relay_recommend` reason cap is unified at 120 chars (schema matches implementation; classic behaviour unchanged). See [CHANGELOG.md](CHANGELOG.md).

The plugin is intentionally non-invasive: it does not patch the kernel, does not install a second compaction engine, does not filter messages, does not delete history,. Compaction and handoff are always opt-in and human-gated.

## 2. What you get after installing

**Mode selector.** Create a session and pick **Relay (接力模式)** for normal long tasks (Lead keeps all tools) or **Relay · 超长任务** for sessions expected to run for hours (Lead only dispatches; execution tools are hidden). The preset is fixed once the session starts (DSH cannot switch presets mid-session).

**Composer chip.** Below the input box, next to the ContextMeter, a Relay chip (relay sessions only — a non-relay session renders no chip at all, v0.3.1) shows the live context percentage/band and **the next action itself** (Ask me / Compact / New session / Continue / Compact→New session / Auto). Clicking it opens a non-blocking popover with:

- a one-shot default operation for the next threshold crossing, presented as a **cyber-gothic engine-order-telegraph dial (v0.3.1)**: the **classic** Relay mode keeps six detents spaced 60° around a full circle (ask me, continue, compact, compact→new session, hand off, auto), while **Relay · 超长任务** shows only **four detents** 90° apart (ask me / continue / compact / hand off) — the three operations are continue / compact / hand off, and v0.3.4 removed "compact→new session" from the long mode entirely (classic keeps it; `relay_recommend` rejects it in long mode and an existing stored value is normalised to continue and cleared); "auto (model decides)" is still hidden there (an existing stored value is displayed as "continue" and normalised to continue semantics by the host; a new long-mode root session is seeded with `continue`), and the hand-off detent is labelled **team restart** (the old session is archived and its teammates/background jobs are interrupted). Visuals: a near-black stone niche with neon cyan/magenta/purple, a 12-petal rose window with twin pointed arches and finials, tri-colour stained-glass sectors, rune ticks and a **metal blade needle with a cyan→magenta neon edge** (all inline SVG; system serif stack with wide letter-spacing, no external fonts; the dial and its labels keep a fixed dark palette so they stay readable in light and dark themes), a **216 px round face** and clickable sectors that divide the whole dial evenly (6×60° classic / 4×90° long; hovering highlights the sector under the pointer plus its label), and the needle always takes the **shortest arc** between orders (classic auto 300° ↔ ask-me 0° moves only ±60° instead of spinning the long way). Pick an order by clicking a sector or a detent, dragging the needle (snaps to the nearest detent on release), or ←→↑↓/Home/End; write semantics are unchanged (`defaultOperation` and `autoChoose` are mutually exclusive; clicking the same detent does not repeat the write; a failed write resets a drag preview after 1.5 s). All animation only touches transform/opacity and non-layout paint properties (colour, shadow, SVG fill/stroke), honours `prefers-reduced-motion`, and the needle swing-in plays once per open; "compact→new session" in classic is strictly two-stage: the first crossing only compacts and stays in the current session, the second crossing hands off (if a compaction leaves usage above the line, the same vs. next crossing cannot be distinguished and the handoff is allowed — known boundary);
- three per-session switches rendered as **water-tank buttons** (no checkbox): blue for autoCompress, green for autoHandoff, sakura-red for injecting the unlimited-budget line into the next handoff session. Turning one on floods the whole row by **several water elements anchored to the same fill (delay 0, all starting together)**: the water level rises over 450 ms with a little inertia (its top edge is a smooth SVG-mask wave) while a surface wave layer drifts slowly across it over 900 ms and flattens as the tank fills, five white droplets pop from the surface, and a white surface-highlight line rides up — the final level fills the whole row (no air gap), so the wave IS the water surface and nothing detached flies across the row. The third row (inject the unlimited-budget line into the next handoff session) no longer floods: it wears the **same Unicorn circuit veins as the Relay chip**, wiped in left-to-right (clip-path + fade) with three rising sparks; turning it off plays the same transition group in reverse (pure CSS transitions, no canvas/rAF/keyframes). Dark glass base with a faint coloured glow; the three colours, aria-pressed and the written fields are unchanged (v0.2.30). The v0.2.29 canvas water-surface engine now lives in the one-shot "authorize next operation" button at the bottom of the panel: empty when unauthorized (yellow), fills green on click (simultaneously with the button's 300 ms yellow→green crossfade) and drains when cancelled;
- a status dot on the chip reflecting the authorization state, and the number of compactions this session has performed; when this session budget-unlimited toggle is on, the Relay chip wears **Unicorn-red psycho-frame circuit veins with three rising red sparks** on a transparent, non-glowing background — the dark-red base, glowing halo and sparks appear only when the session is over budget (pure CSS, `prefers-reduced-motion` disables it; the budget-unlimited capsule itself is unchanged);
- a two-state slide toggle selecting **the mode of the next handoff-created session** — Relay (all tools) vs Relay · 超长任务 (Lead only dispatches). The default follows the current session's preset; the choice is saved per session (`panel.json` `handoffPreset`) and is sticky, and it never changes the current session or the mode selector. Its knob/track/label animations honour `prefers-reduced-motion`.

**Budget-unlimited capsule.** To the right of the model/reasoning-effort selector, a chip-styled capsule toggles the per-session system-prompt line "Your token budget is unlimited" (relay sessions only; green = on, struck-through = off). The handoff switch in the chip popover decides whether the new session inherits it.

**Simple questions only (bounded).** In relay sessions `ask_user_question` uses the official **timed** mode with `timeout:60` — it is meant **only for simple questions** (yes/no, pick one, low-risk confirmation, one missing fact). If no answer arrives within 60s the tool returns `pending`, the model keeps working or switches to a plain-language report, and the question stays answerable; `pending` is neither a skip nor consent. **Complex questions do not use the ask tool**: decisions, trade-offs and boundary changes are reported through ordinary messages (plain language: conclusion and impact → options with recommendation + default + consequences → wait for the user's reply). Takes effect in **new relay sessions after a plugin reload**.

**Handoff dock notice.** When a handoff completes, the originating session shows "Handoff complete — new session created" and an **Open new session** button. It never navigates automatically and is never shown in another session.

**Threshold notices.** When the context band rises (warn → organize → relay), the plugin injects a short notice into the model's next step — rendered as a plugin notice, not a user message. It reports the band/thresholds and the phase-first guidance only; it does not ask for a mid-phase action, and handling happens at the phase boundary. The same band is not repeated, a successful compaction re-arms it, and one more boundary reminder is injected when a phase completes while still above the line.

**Sidebar card.** Settings → Plugins → Relay configures the threshold base and the default values used by new (or untouched) sessions.

**Phase state machine.** The model drives phases; the tools enforce the contract:

```text
discover → decide → build → verify → ship
```

- `contract_check{requirement, fidelity, attention}` is mandatory on every switch;
- `discover` / `decide` require `exit_criteria` (who / with what / judged how);
- when the budget band is `warn`, opening a phase requires a `budget_plan` (`proceed` / `split` / `relay`);
- `ship` is reachable only from `verify` and requires `user_gate{review, report, questions?}` (each question needs a recommendation) — the acceptance gate is a fresh-context independent review (requirements/boundaries settled; implementation faithful, with a deliberate hunt for drift, degradation, shortcuts, and missing work) plus a plain-language report. The host only enforces that it is non-empty; it does not machine-grade correctness, and no approval dialog is involved.

**Tools visible to the model** (under PTC, call them through `run_code`'s `tools.*`): `relay_status`, `relay_phase`, `relay_organize`, `relay_handoff`, plus `doc_lint`.

**Bundled skills:** `human-loop` (human–agent protocol), `context-relay` (operator manual, hidden from the model catalog), `doc-governance` (documentation governance).

## 3. Installation

Requirements: DSH ≥ 0.2.1-rc.2 (declared in `dsh.engines`; the plugin depends on projection / approval / tool-gate APIs from that line), Node.js ≥ 20, and the web profile.

npm (after publication):

```sh
dsh plugin --profile web add dsh-context-relay
```

From a Git repository:

```sh
dsh plugin --profile web add github:rezon-aki/dsh-context-relay
```

From a local checkout (development):

```sh
dsh plugin --profile web add /absolute/path/to/dsh-context-relay
```

Then restart `dsh web`. Changing the bundle set requires a profile restart.

**Install from the DSH Web UI sidebar (no CLI needed):**

1. Open the sidebar **Plugins** view → click **Add plugin**.
2. In **Choose how to add a plugin**, pick **npm package** (a Git repository URL or a local directory path also works).
3. Enter the package name `dsh-context-relay` (keep the default npm registry as the install source).
4. Click **Install**, then restart/reload the profile and refresh the page.

The package ships its own `cordis.patch.yml` (declared as `dsh.bundle.patch`), so the host-plane row registers automatically. The relay preset itself is declared dynamically via `ctx.agentPresets.register` on activation and deregistered on uninstall. **Do not manually insert the same id into the profile patch** — a duplicate loader entry id prevents startup.

Local development without build or restart (requires dsh-super-injector):

```console
dev_inject_plugin {"dir": "/absolute/path/to/dsh-context-relay"}
```

Upgrade / uninstall: `dsh plugin --profile web update dsh-context-relay` or `dsh plugin --profile web remove dsh-context-relay`, then restart. The plugin has no build step; both the host and the client bundle are hand-written ESM.

## 4. Quick start

1. Restart the web profile, create a new session, and choose **Relay (接力模式)**.
2. Start with `relay_status` and read the pressure, phase, and budget. Call it again before delegating and at the start of each phase.
3. Declare the first phase. Every switch carries the contract check; `discover` / `decide` also need a verifiable exit criterion:

```js
await tools.relay_phase({
  phase: "discover",
  goal: "Understand the failure and agree on scope",
  exit_criteria: "Lead + a failing repro; root cause identified and scope signed off",
  contract_check: {
    requirement: "Which user requirement this phase serves; which ambiguity is left",
    fidelity: "No drift / degradation / shortcut / missing work in this phase",
    attention: "Nothing needs the human right now (or why it is minimal and high-impact)",
  },
});
```

4. Work the phase. At each boundary, switch with `relay_phase` and a fresh `contract_check`. In the `warn` band, add `budget_plan`; past the organize line, do not open a new phase.
5. When context is over budget at a phase boundary, the human or the panel chooses: `relay_organize` (controlled compaction + brief) or `relay_handoff` (fresh session). Both are optional. `relay_status.continue.recommendation` suggests one (never compacted → compact; already compacted → hand off; relay band → hand off). Both still follow the approval rules in §5. With the two-stage `compress-then-handoff` preset, the first crossing only compacts and stays in this session; only the second crossing hands off. Once compaction brings usage back below the line, a handoff at the same crossing is refused with `two-stage-not-due`. Known boundary: if the compaction leaves usage above the line, the same vs. next crossing cannot be distinguished, so the handoff is allowed (line-crossing semantics).
6. Finish with `verify → ship`, including `user_gate{review, report}`. The review must come from a fresh context (a new session / teammate / subagent), not from the implementer.

## 5. Safety boundaries and costs

- **Approval hard gate.** `relay_organize` and `relay_handoff` go through the official `tools/pre-execute` approval gate: it fails closed, and only `allowed-once` passes. Exemptions come **only** from `autoCompress` (any compaction), `autoHandoff` (handoff), and `authorizeNext` (one-shot, consumed on success). **A one-shot panel preset only decides *what* to do — it grants no approval exemption.** `handoffApproval: "off"` exists for deployments without an approval UI (residual risk is accepted by the deployment).
- **Human confirmation.** `relay_handoff` requires `human_approved: true` and creates a new top-level session — it consumes API quota, and the new session starts its first turn automatically.
- **Phase-boundary gating.** The over-budget `relay_phase` switch and the `ship` acceptance do **not** go through approval. Budget gating is the composer panel's job; acceptance is the fresh-context review + report (non-empty enforced, content not machine-graded).
- **Compaction is a deliberate one-shot reduction.** `relay_organize` triggers the official engine with `context-overflow` (retain = 0) to shrink into a clean range (post-compaction floor is roughly 24k tokens). This can drop more history than expected — old detail survives only as the structured brief, so write important conclusions into the brief, docs, or the handoff. Mitigations: only at phase boundaries, only after an explicit human/panel choice, at most once per session (a second requires `force`), any compaction still passes approval, and brief injection plus handoff pointers preserve the key facts.
- **Old sessions are kept for audit, never deleted.** DSH only shadows/replaces history, so the old session remains auditable (marked `handedOff`). Handoff cleanup interrupts running teammates/subagents, cancels background jobs owned by the old session tree (including teammate/subagent-owned ones), and migrates scheduled tasks to the new session. Cleanup is best-effort: failures are recorded in `handover.cleanup.errors` and do not block the handoff; a failed migration keeps the old row. The plugin does not hard-block further work in the old session — do not keep working there after a handoff.
- **P0 rule.** The bundled `human-loop` skill defines P0 as irreversible / external (publish, send, release) / paid / credential / permission / production change / data deletion. P0 stops for an explicit human Go/No-go — timeout is not consent, and a conversational "ok" is not approval. The Lead is the only human interface; teammates escalate to the Lead and never decide P0 themselves. `relay_organize` / `relay_handoff` are lead-only: subagents and teammates get a structured refusal and ask the Lead.
- **No automatic loop.** Relay stays human-gated and never runs multi-round handoffs by itself. Repetitive, off-screen, workspace-as-memory bulk work belongs to Ralph / workflows / subagents.
- **No UI takeover.** A handoff only produces a dock notice with a manual "Open new session" button; it never switches pages automatically.

## 6. Configuration

### 6.1 Sidebar settings (`settings.json`, six fields)

| Field | Default | Meaning |
|---|---|---|
| `threshold` | `35` | Organize line as a percentage of the context window. `warn` = base − 5, relay hard line = base + 10 (default 30 / 35 / 45). Clamped to 20–85 on save. |
| `defaultOperation` | `null` | One-shot default operation for new or untouched sessions: `null` (ask me), `compress`, `handoff`, `continue`, `compress-then-handoff`. |
| `autoChoose` | `false` | The model decides between compaction and handoff at the next crossing (recorded via `relay_phase({next_operation})`). Mutually exclusive with `defaultOperation`. |
| `autoCompress` | `false` | Persistent per-session auto-approval for any compaction. |
| `autoHandoff` | `false` | Persistent per-session auto-approval for handoff. |
| `unlimitedBudget` | `true` | Default for the per-session "budget unlimited" injection. The sidebar no longer edits it (the composer capsule does); it is kept as the default value and for legacy compatibility. |

Notes:

- Defaults only apply to new sessions, or to sessions the human has not changed in the composer panel. Once the human writes the panel, that per-session snapshot wins and stops following later default changes. Agent-internal writes (auto-decision, authorization consumption) do not freeze defaults.
- Legacy fields `autoPhase` / `autoContinue` are ignored.
- **Threshold sources** (single source, highest priority first): `settings.json` saved by the human → host `config.settings` → `config.threshold` shorthand → legacy `config.thresholds` (only when the previous ones are absent) → built-in base 35. `GET /context-relay/settings` and `GET /context-relay/panel` always return the effective `thresholds`.
- When the window is unknown, absolute token fallbacks apply: 100k / 130k / 160k. When the window is known, only the ratio lines are used (on a 1M window an absolute 100k line would trigger far too early).

### 6.2 Composer panel (`panel.json`, per session, ten fields)

| Field | Values | Notes |
|---|---|---|
| `defaultOperation` | `null` / `compress` / `handoff` / `continue` / `compress-then-handoff` | One-shot for the next threshold crossing; consumed on success, cleared to `null` (does not fall back to the sidebar default). `compress-then-handoff` is strictly two-stage: the first crossing only compacts and stays in the current session, the second crossing hands off (if compaction leaves usage above the line, same vs. next crossing cannot be distinguished and handoff is allowed — see §8). |
| `autoChoose` | boolean | The model decides; records its decision first. Mutually exclusive with `defaultOperation`. |
| `autoCompress` | boolean | Persistent per-session approval exemption for any compaction. |
| `autoHandoff` | boolean | Persistent per-session approval exemption for handoff. |
| `authorizeNext` | boolean | One-shot exemption for the next relay operation (compaction or handoff); consumed on success, not on failure/refusal. |
| `unlimitedBudget` | `true` / `false` / `null` | Per-session "budget unlimited" injection; `null` = follow the global default (the GET response resolves it to the effective boolean). |
| `handoffUnlimitedBudget` | `true` / `false` / `null` | Value applied to the new session after a handoff; `null` = follow the current session. |
| `handoffPreset` | `null` / `'relay'` / `'relay-long'` | Mode of the next session created by `relay_handoff`; `null` = follow the current session's preset. Sticky: a successful handoff does not consume it. PUT accepts only `null` / the two registered preset ids (anything else → 400 `invalid-handoff-preset`); a missing or syntactically invalid value in an old `panel.json` normalizes to `null`, and a value that is not one of the registered ids falls back to the current session's preset at handoff time. |
| `handedOff` | boolean | **Internal.** The session has been handed off; reminder injection is skipped. |
| `autoDecision` | object / `null` | **Internal.** The model's recorded next operation (only valid while `autoChoose` is on). |

The per-session state is persisted to `~/.dsh/data/dsh-context-relay/panel.json` (`panelPath` overrides it). Human panel writes store a full session snapshot; agent-internal writes only record per-session state. `PUT /context-relay/panel` accepts only the public keys above; `handedOff` / `autoDecision` cannot be written externally.

### 6.3 Host plugin config

| Key | Default | Meaning |
|---|---|---|
| `presetId` | `'relay'` | Mode id of the registered preset. |
| `thresholds` | legacy ratios 0.35 / 0.40 / 0.50; token fallback 100k / 130k / 160k | **Legacy** thresholds. Only used when neither `settings.json`, `config.settings`, nor `config.threshold` exists. Ratios must be strictly increasing in (0,1); token thresholds strictly increasing; invalid config makes plugin apply throw (fail loud). |
| `settings` | `{threshold: 35, defaultOperation: null, autoChoose: false, autoCompress: false, autoHandoff: false, unlimitedBudget: true}` | Deployment defaults for the sidebar settings. Overridden by `settings.json` once the human saves. |
| `threshold` | — | Shorthand for `settings.threshold`. |
| `panelPath` | `~/.dsh/data/dsh-context-relay/panel.json` | Per-session composer panel persistence file. |
| `settingsPath` | `~/.dsh/data/dsh-context-relay/settings.json` | Sidebar settings persistence file. |
| `injectBrief` | `true` | Inject the phase brief after a successful compaction. `false` is the off-arm for strict inject / no-inject A/B tests. |
| `handoffApproval` | `'required'` | Official `tools/pre-execute` approval hard gate for `relay_handoff` and any `relay_organize`. `'off'` is only for deployments without an approval UI. |
| `inheritOnHandoff` | `true` | The new session inherits the old session's model route (provider/model/effort/maxTokens) and permission preset (including `danger-full-access` / `never`). `false` returns the new session to deployment defaults. |

Host config is passed through to the relay-agent row through the `AGENT_OPTION_KEYS` whitelist; unset keys are not written, so they do not pollute the preset definition.

## 7. Tools and HTTP API

All relay tools run under PTC through `run_code`'s `tools.*`. Failures use a structured `{ok: false, code, error}` contract, and rejected calls have no side effects.

| Tool | Purpose |
|---|---|
| `relay_status` | Live pressure, band, phase, budget headroom and continue recommendation for the Lead and every teammate. Call at phase start and before delegating. Returns structured fields (`lead`, `team`, `continue`, `diagnostics`, `budget`) plus a `text` summary carrying thresholds, A/B options, and budget facts (headroom to organize/relay, current-phase consumption, previous-phase measured cost). |
| `relay_phase({phase, goal?, exit_criteria?, contract_check?, user_gate?, next_operation?, budget_plan?, lessons?})` | Declare or switch phase. Mandatory `contract_check` on every switch; `exit_criteria` for `discover`/`decide`; `user_gate` for `ship` (only from `verify`); `budget_plan` when the band is `warn`. Over-budget switches follow the panel one-shot default / auto authorization; refusals have zero side effects and do not consume presets. `lessons` (≤3, each with evidence) is stored in `.scratch/context-relay/lessons.md` (deduplicated, capped at 40 entries / 8KB). |
| `relay_organize({phase, brief?, key_docs?, force?})` | Lead-only controlled compaction: guard order is per-session lock → threshold → second-compaction guard (≥1 and no `force`) → engine availability → write brief → official compaction → inject brief after success. `organizeCount` only counts real successful compactions; rejected paths have zero side effects. |
| `relay_handoff({human_approved: true, status?, evidence?, key_docs?, ...})` | Lead-only bounded handoff: total ≤ 8KB, each item ≤ 200 chars, per-list caps. User content over a cap is rejected with `handoff-truncated` + caps + a fix hint **before** any file or session is created, so a shortened retry is idempotent. Writes the handoff snapshot, creates the new session, updates the rolling progress file (`.scratch/context-relay/progress.md`, ≤ 8KB; the oldest content is archived to `progress-archive-<year>.md`), then sends the first message — so the documentation is on disk before the new session receives its first message. The protocol asks the model to finish the documentation first: phase brief, the three closeout lists (done / not done / not attempted), decisions with evidence pointers. For the two-stage `compress-then-handoff` preset it refuses with `two-stage-not-due` when stage-1 compaction is done but the session is not at the line again (zero side effects). Returns `sessionId`, `handoffPath`, `caps`, `inherited`, `handover` (cleanup report), and `progress`. Requires the approval gate and `human_approved`. |
| `doc_lint({paths?})` | Four documentation checks (quota, banned wording, index paths, git). Accepts only workspace-relative documents (≤ 20); output ≤ 2KB; unavailable checks report `UNKNOWN`, never a fake pass. |

### HTTP API

Same-origin only; authentication uses the official `connection.requestRejection` (401/403 on rejection, authentication-layer errors fail closed with 503, handler errors return JSON 500, non-GET/PUT returns 405, PUT body over 8KB returns 413).

| Endpoint | Behaviour |
|---|---|
| `GET/PUT /context-relay/settings` | Read or update the six-field settings. GET returns the effective values, the derived `thresholds`, and `explicit`; PUT is a partial merge. Invalid values return 400; the threshold is clamped to 20–85. Persistence-first: a disk write failure returns 500 `settings-persist-failed` with no in-memory half-commit. |
| `GET/PUT /context-relay/panel?sessionId=` | GET returns `{ok, sessionId, relay, panel, live, thresholds, settings:{threshold}, modes:{relay,long}, preset}` — `modes` carries the two registered preset ids used by the handoff-mode toggle, and `preset` is the session's current preset. `relay` reflects whether the session's **current** preset is relay (from the `agentPreset` projection, falling back to the creation header). `live` is the pressure published by the agent each step; when missing or older than the 10-minute TTL the host derives it synchronously from the official projections (`derived: true`); if neither is available, `live` is `null` and the client renders a neutral degraded chip. PUT accepts `defaultOperation`, `autoChoose`, `autoCompress`, `autoHandoff`, `authorizeNext`, `unlimitedBudget`, `handoffUnlimitedBudget`, `handoffPreset`; an invalid `handoffPreset` returns 400 `invalid-handoff-preset`. A panel write failure still returns 200 with `persisted: false` (in memory only, not falsely "saved"). Invalid `sessionId` returns 400. |
| `GET /context-relay/api` | Read-only handoff publication box: `{ok: true, handoffs: [...]}`, latest 8 entries, newest first. The client bundle polls it to show the dock notice; there is no self-built authentication surface. |

Persistence files are quarantined to `*.corrupt-<ts>` with a warning when corrupt, and defaults are used.

## 8. Known limitations

- **Benefit A/B not run** — the real benefit of long sessions (≥ 3 phases) and the exact threshold inflection are not A/B-tested. The design is evidence-backed but not proven per task.
- **Compaction fidelity** — a small 2026-10-20 experiment measured roughly 54% fact retention after one compaction and roughly 8% after two (high variance). Brief injection improves the outcome; a strict inject / no-inject A/B has not been run (`injectBrief: false` is the ready off-arm).
- **Visual acceptance pending** — capsule/switch/slide-toggle placement and animation feel, spacing and popover wrapping are not covered by automated visual tests; verify them visually after installation.
- **Old session agent plane** — sessions created before a plugin reload keep their old agent plane. New agent-side behaviour (for example the latest injection capsule / handoff switch) only takes effect in a relay session created after the reload.
- **Web profile only** — verified on the DSH web profile; headless and other deployments are untested.
- **"Compact → new session" two-stage preset** — covered by unit tests only; no real end-to-end handoff (it creates a session and spends quota). Known boundary: if a compaction leaves usage above the line, the same vs. next crossing cannot be distinguished and the handoff is allowed.
- **Panel persistence** — a `panel.json` write failure keeps the state in memory only (`persisted: false`) and it is lost on restart. Settings writes are persistence-first (500, no half-commit).
- **Handoff inheritance carries permissions** — with `inheritOnHandoff: true`, a `danger-full-access` + `never` session hands off to an equally privileged new session; the approval gate is the human checkpoint (`autoHandoff` / `authorizeNext` can skip it).
- **Cold-start chip** — real values are derived from the official projections when available; if neither live state nor derivation is available, the chip shows a neutral degraded state (`?`), and a two-stage preset may display "compact" first until the next step self-heals.
- **Docs are Chinese-first** — this English README is an entry-point overview; the Chinese README is the primary reference.
- **UI strings are Chinese-only** — the composer chip, popover, sidebar card, and dock notice are hard-coded in Chinese in the current version. The English names in this README are descriptions, not the literal button labels.

## 9. Development and testing

```sh
npm test        # node --test test/*.test.mjs — full node:test suite
npm run check   # syntax-check every lib entry point
```

Note: on Node 22.22.1, `node --test test/` fails because the directory is treated as a module; use the glob above (which is what `npm test` does). Tests are `node:test` suites under `test/`; some integration tests auto-skip when the official DSH session packages are unavailable.

Repository layout:

- `lib/index.js` — host plane: relay preset registration, projection registration, skills, HTTP routes (settings / panel / handoff api).
- `lib/agent.js` + `lib/agent/{protocol,tools,derive,sentinel,panel-gate,handoff,progress,shared}.js` — preset plane: protocol prompt, the five tools, state derivation, sentinel reminders, panel gate, handoff, rolling progress.
- `lib/policy.js` — pure functions: thresholds and bands, phase validation, brief, bounded handoff, settings/panel normalization.
- `lib/panel-store.js` — per-session panel state persistence and sidebar defaults.
- `lib/projection.js` — official `sessionProjections` fold (key `relay`, stateVersion 2).
- `lib/lint.js` — the `doc_lint` implementation.
- `lib/preset-base.js` — data asset for the official PTC preset rows.
- `lib/handoff-store.js` — M3 handoff publication box (globalThis, latest 8).
- `lib/client.js` — sidebar config card, composer chip/popover, budget capsule, dock notice.
- `skills/` — `human-loop`, `context-relay`, `doc-governance`.
- `CHANGELOG.md` — user-facing release history (what changed in each version).

No build step: the host and client bundles are hand-written ESM; hot-inject for development or install as a bundle via `cordis.patch.yml`.

## 10. Documentation and license

- [CHANGELOG.md](https://github.com/rezon-aki/dsh-context-relay/blob/main/CHANGELOG.md) — user-facing release history: what changed in each version.

Internal design, acceptance, audit and research documents are intentionally not published; the release contains code, bundled skills, READMEs, this changelog and the license only.

License: **MIT** — see [LICENSE](https://github.com/rezon-aki/dsh-context-relay/blob/main/LICENSE).


