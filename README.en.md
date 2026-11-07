# dsh-context-relay

> Keep a Lead agent inside its high-efficiency context window on long tasks.

[中文](README.md) · [npm](https://www.npmjs.com/package/dsh-context-relay) · [Changelog](CHANGELOG.md) · MIT

**DSH context-relay plugin** adds two optional agent modes to DeepSeek Harness — **Relay** and **Relay · 超长任务 (very long tasks)** — built around a phase protocol, a budget sentinel, controlled compaction and bounded handoff. The long-task mode also ships teammate freshness (checkpoint / true-wipe reset / renewal / rehydrate).

## Why

Once a Lead agent's context grows, it drifts from the implementation, repeats work and over-builds. DSH's built-in auto-compaction only fires near the window limit, is summarisation-based and breaks the prompt prefix cache — it rarely pulls attention back into the efficient range.

This plugin does not replace the kernel compaction engine and does not delete history. It turns *when to compact, when to hand off, and how to hand over* into an auditable protocol:

| Capability | In one line |
|---|---|
| **Phase state machine** | discover → decide → build → verify → ship, to organise long tasks by phase |
| **Budget sentinel** | Warns as context approaches the thresholds; the decision point sits at phase boundaries, never mid-phase |
| **Controlled compaction** | `relay_organize` writes a structured brief, runs the official compaction engine, then injects the brief |
| **Bounded handoff** | `relay_handoff` produces a ≤8KB handover and creates a fresh session; the old one stays as an audit record |
| **Model recommendation** | `relay_recommend` sends the model's recommendation to the composer panel for highlighting — advice only, never auto-executed |
| **Teammate freshness** | Long-task mode only: checkpoint / true-wipe reset / renew / rehydrate |

## Install

Requires DSH `>=0.2.1-rc.2` and Node.js `>=20`.

### Option A (recommended): DSH Web UI sidebar "Plugins"

Everything stays in the Web UI — no command line needed:

1. Open the DSH Web UI and click **Plugins** in the left sidebar.
2. Click **Add plugin** in the top-right. (The arrow next to it opens the "Choose how to add a plugin" menu; **Install third-party plugin** leads to the same dialog.)
3. In the install dialog, fill **Package name** with `dsh-context-relay` (append `@<version>` to pin one). The dialog also accepts Git URLs, tarballs and absolute local paths.
4. Leave **Install source** at its default: on first use it probes the official npm registry and the mainland-China mirror and uses whichever responds first. You can also pick the official npm registry / mainland-China mirror / a custom http(s) URL manually.
5. Click **Install**. The Host first resolves the package and shows its name, one-line description and version; pnpm commands and output stay folded under **View install details**.
6. When installation completes, click **Enable now**. If you closed the dialog, open the `dsh-context-relay` bundle from **Installed plugins** on the Plugins page and switch it on.
7. Follow the prompt to **restart/reload the profile** (profiles with HMR rebuild automatically; otherwise restart `dsh web`), then **refresh the page**.
8. Create a new session: the mode picker should now show **Relay** and **Relay · 超长任务**; after selecting either, the **relay chip** should appear above the composer. Both together mean the install succeeded.
9. Optional: the `dsh-context-relay` config card on the Plugins page sets the threshold basis and panel defaults.

**Troubleshooting**

- No modes after install → make sure the bundle is enabled, the profile was reloaded and the page was refreshed; **a successful install does not by itself activate the module**.
- No relay chip → the chip only renders in relay sessions; sessions created before the reload keep the old agent plane — create a new session.
- Updating → uninstall and reinstall to upgrade (this plugin is not an official on-demand bundle, so there is no built-in "Update" action).

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

- Two extra presets in the mode picker: **Relay** (default; the Lead keeps its full toolset) and **Relay · 超长任务** (the root Lead dispatches but does not execute: `bash/pwsh/write/edit` are hidden on its agent layer — a soft guard, not a security boundary).
- A **relay chip** above the composer (relay sessions only): live context usage, band and next operation; click it to open the panel.
- The panel: a one-shot default-operation dial (6 detents in classic Relay / 4 in the long-task mode), three auto-authorisation toggles (compact / hand off / authorise next), a "budget unlimited" toggle, the model-recommendation row, and a "mode of the next session" slider.
- A **budget-unlimited capsule**: injects one line, `你的 token 预算无上限。`, per session (prompt text only — it does not raise kernel limits).
- A plugin notice when a threshold is crossed (not a user message): it reports status and phase-first guidance without interrupting the current phase.

## Quick start

1. `relay_status` — check the current phase, context usage, band and budget headroom.
2. `relay_phase({phase:"discover", goal, exit_criteria, contract_check})` to begin. Every phase switch takes `contract_check` (requirements settled / implementation faithful / is human attention worth spending).
3. Never let the budget interrupt a phase — it is a **phase-boundary gate**.
4. When over the line (organize / relay band), handle it at the next phase boundary according to the panel / the human's decision:
   - **Continue**: no compaction, no handoff;
   - **Compact and continue**: `relay_organize` performs one controlled compaction (at most once per session; `force` needs the human to insist);
   - **Hand off to a new session**: `relay_handoff` writes the handover and creates a new session; teammates and background jobs of the old session tree are interrupted or migrated;
   - **Compact → new session** (two-stage, classic Relay only): the first crossing only compacts; the second crossing hands off.
5. Before delivering, enter `ship`: it requires a fresh-context independent review (`user_gate.review`) and a plain-language report (`user_gate.report`).

## Configuration

Optional host plugin config:

| Key | Default | Meaning |
|---|---|---|
| `threshold` / `settings.threshold` | 35 | Threshold basis (%): warn = basis−5, organize = basis, relay hard line = basis+10. |
| `settings` | six-field defaults | Initial sidebar defaults; the human-saved `settings.json` wins. |
| `thresholds` | 0.35 / 0.40 / 0.50 | Legacy thresholds, used only when no settings source exists. |
| `panelPath` / `settingsPath` | `~/.dsh/data/dsh-context-relay/…` | Persistence-path overrides. |
| `injectBrief` | `true` | Whether the brief is injected into the next step after compaction. |
| `handoffApproval` | `'required'` | Official approval hard gate for compaction/handoff; `'off'` for deployments without an approval UI (risk accepted by the deployment). |
| `inheritOnHandoff` | `true` | The handoff inherits the old session's model route and permission profile; `false` returns to deployment defaults. |
| `presetId` / `longPresetId` | `relay` / `relay-long` | The two mode ids. |

Sidebar settings (human-editable, hot-reloaded): threshold basis, default operation, auto-decide, auto-compact, auto-handoff, budget unlimited.

Panel state (per session, `panel.json`): one-shot default operation, auto-authorisations, auto-decision record, handoff target mode, budget unlimited, and the three model-recommendation fields.

Data files: `~/.dsh/data/dsh-context-relay/settings.json` and `panel.json`. Message/session content remains stored by DSH itself.

## Tools and HTTP API

| Tool | Purpose |
|---|---|
| `relay_status` | Read context usage / band / phase / budget headroom / advice. |
| `relay_phase` | Declare or switch phase; validates exit_criteria, contract_check and warn-band budget_plan; `ship` requires `user_gate`. |
| `relay_organize` | Controlled compaction: write the phase brief (with automatic doc_lint evidence and key-doc entry points) → official compaction → inject the brief. |
| `relay_handoff` | Produce a ≤8KB handover (including the rolling progress file), create a new relay session and clean up the old session tree. |
| `relay_recommend` | Lead-only: write the model's recommendation to the panel (cleared on phase switch / compaction / handoff / human choice). |
| `doc_lint` | Four-part documentation check (quota / banned wording / index / git), output ≤2KB. |

**Relay · 超长任务** adds team tools: `relay_team_status`, `relay_renew`, `relay_rehydrate` (Lead) and `relay_checkpoint`, `relay_freshen` (teammates).

HTTP (available only behind the local GUI authentication): `GET/PUT /context-relay/settings`, `GET/PUT /context-relay/panel`, `GET /context-relay/api` (handoff publication box).

## Safety boundaries and costs

- **Approval hard gate**: `relay_organize` / `relay_handoff` go through the official approval gate by default (fail-closed; only `allowed-once` passes). Exemptions come **only** from panel `autoCompress` / `autoHandoff` / `authorizeNext`; a one-shot preset decides *what* to do, never grants an exemption.
- **A handoff creates a new session and consumes quota**: it interrupts running teammates/subagents of the old session tree, cancels their background jobs and migrates scheduled jobs; the old session is marked `handedOff` as an audit record.
- **Compaction is lossy**: old conversation detail survives only in the structured brief. Put important conclusions in docs/handoffs.
- **No autonomous loop**: relay stays human-gated. Use the official Ralph / workflow / subagent for repetitive off-screen work.
- **P0 rule**: irreversible / external / paid / credential / delete actions are reported first and require an explicit human Go. The plugin never auto-approves them.

## Known limitations

- Sessions created before a plugin reload use the old agent plane; new behaviour applies to relay sessions created after the reload.
- Verified on the DSH Web profile only; headless and other deployments are untested.
- The real benefit of compaction/handoff depends on model and task length; thresholds are not universally optimal.
- Visual details have no automated regression coverage — inspect after installing.
- Compaction fidelity/benefit has no strict A/B; neither does the threshold inflection.
- The two-stage "compact → new session" preset is covered by unit tests only, no real end-to-end handoff (it creates a session and consumes quota).
- If writing `panel.json` fails, panel state lives in memory only (lost on restart); settings writes are persist-first.
- Composer chip / popover / sidebar card text is Chinese-only; Chinese docs are the source of truth.

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
