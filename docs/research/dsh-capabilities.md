# DSH capability brief — facts for a ticket-pipeline plugin

Grounded in the installed 0.2.1-rc.5 tree: `D:\ProgramFiles\deepseekharness\resources\app.asar` (inside it `dsh/node_modules/@deepseek-ai/…`) and the live profile `C:\Users\Administrator\.dsh\profiles\desktop\`. "asar" = that archive; quoted READMEs are extracted to `.scratch/_reference/dsh-plugin-docs/`.

## 1. Plugin system

A DSH plugin **is** a Cordis plugin. A *bundle* is any package whose manifest declares `dsh.bundle.patch`; that YAML patch inserts plugin rows into the composed profile tree (`skill__references_host-plugin.md:3`, copied from asar `…/dsh-agent-preset/skills/cordis-plugin-development/`).

Real installed layout — `…\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\`: `package.json:40-52` declares `dsh.bundle.patch: "./cordis.patch.yml"` plus `dsh.client { platform: "web", inject: ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-modules"] }`; `lib/index.js:8399` `const name = "dsh-better-sidebar";`, `:8401` `const inject = ["webServer","sessions","connection","tools"];`, `:9323` `function apply(ctx, config)`, `:9804` `export { Config, …, apply, inject, name };`

Fields DSH reads: `name`, `version`, `type:"module"`, `exports`, `files`, `dsh.bundle.patch`, `dsh.client.{platform,inject,immediately}`, `engines`. Field notes: `engines.dsh` is **enforced** at install against `dsh --version` (`dsh-ops/package.json:257-260` → `{"node": "^22.19 || >=24", "dsh": ">=0.2.0-rc.2 <0.2.2-0"}`); `dsh-plugin.json` is optional market metadata only.

Entry point = `exports["."]`. Registration happens *only* inside `apply`, via effect-returning calls: `ctx.tools.register(defineTool({...}))` (`dsh-tool-todo/lib/index.js:95`), `ctx.commands.register`, `ctx.on('agent/created', …)`, `ctx.effect`, `ctx.webServer.register(route)` (`dsh-better-sidebar/lib/index.js:9325` fences with `ctx.connection.requestRejection`), `ctx.slots.inject/register` (§7), or a default-exported service class.

```json
{ "name": "@local/ticket-watch", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./index.js" }, "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```
```yaml
- insert: [ { id: ticket-watch, name: '@local/ticket-watch', config: { pollSeconds: 300 } } ]
```
```js
import z from '@deepseek-ai/schemastery'
export const name = 'ticket-watch'
export const inject = ['timer', 'tools']
export const Config = z.object({ pollSeconds: z.number().default(300) })
export function apply(ctx, config) {
  ctx.effect(() => ctx.timer.interval(() => { /* poll */ }, config.pollSeconds * 1000))
}
```
Install with `plugin_manager` `install_bundle` (target = absolute package dir) — never hand-edit the profile manifest.

## 2. Agent sessions programmatically — three routes

**(a) In-process.** The headless runner is the reference, verbatim from asar `dsh-headless/lib/index.js`: `:317` `const agent = (await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })).agent`; `:340` `agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))`; `:349` `while (true) { await agent.whenIdle(); const idleSeq = agent.session.seq; if (!await subagents?.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === idleSeq) break }`; `:356` `await sessions.flush(agent.session)`; `:362` `io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)`.

`ctx.agents.create` and `ctx.agentLoop.create` are public (`dsh-agent-loop/lib/index.js:1823`, `:1893`); `followup/steer/inject/cancel/whenIdle` are on the Agent (`:806`, `:870`). This is how a plugin spawns a fresh session against a repo.

**(b) CLI** — `dsh --profile headless "<task>"`, `--json` for NDJSON events, `--session-id <id>` to resume; one task per invocation, answer on stdout, reasoning on stderr, exit 0/1. Verified: `dsh.cmd --version` → `0.2.1-rc.5`; `--profile headless --help` works **only when `DSH_HOME` is writable**, else `EPERM: mkdir 'C:\Users\Administrator\.dsh\profiles\headless'` at `dsh-app-boot/lib/index.js:612` → `dsh/lib/bin.js:215`. A run then failed `MISSING_CREDENTIAL: llm-deepseek`: headless disables the managed credential store and reads the launch env, `<cwd>/.env`, then `$DSH_HOME/.env`.

**(c) JSON-RPC over stdio** — `dsh --profile sdk` speaks `@deepseek-ai/dsh-sdk-protocol` (newline-delimited JSON-RPC 2.0): `initialize`, `session/prompt`, `session/resume`, `session/wait`, `session/working-directory/get|set`, `shutdown`; notifications `session.event`, `session.status`, `subagent.started|finished`. `session/prompt` returns only `{messageId}` — **the answer must be rebuilt from `session.event` or awaited via `session/wait`** (`dsh-sdk-jsonrpc-server__README.md:52-54`). No cancel, no session-close: abandoning a turn means killing the process; ACP (`dsh --profile acp`) supports both. No SDK client package ships.

## 3. Scheduling / long-running work

- `ctx.schedule` — durable reminders: one-shot / `every_seconds` / `daily` / `weekly` / **5-field Vixie cron**, min 1 minute; `schedule.create(sessionId, request)` is **session-bound** and delivers by appending a follow-up message. *"Schedule cannot be mounted alone in a headless or SDK-only composition… delivery requires the Host Web Session controller and a Session persistence backend"* (`dsh-schedule__README.md:26`).
- `ctx.timer` — `timeout/interval/throttle/debounce`, disposable, dies with the process.
- `ctx.jobs` — `start/wait/kill/read/list`. **In-process only**: *"Jobs managed by the shipped in-process registry die with the harness process; durable execution across restarts needs a different backend"* (`dsh-jobs__README.md:57`). No durable queue or daemon supervisor exists.

## 4. Settings & state

- **Config**: `export const Config` (schemastery/zod); values live in the plugin's row of the profile `cordis.patch.yml` and survive upgrades.
- **Forms**: `ctx.settings.configure({ auto: false }, ctx.fiber)` inside an optional `ctx.inject(['settings'], …)` child (`dsh-settings__README.md:39`); only `.volatile()` fields are exposed.
- **State**: `ctx.storageDomain` + `defineDomain({name, version, tables})` → `domain.table(t).put/get/update`; backends `dsh-storage-json` (JSON files under a `root`, mode 0700) or `per-record`. **No SQLite package exists.** State is invisible to the model and the loop.
- **Secrets**: `ctx.credentials.set/describe/unset` with `credentialRef()`; default `~/.dsh/.credentials.yaml`. Precedence: stored file → launch env → `<cwd>/.env` → `$DSH_HOME/.env`. The README warns it "cannot isolate secrets from the agent".

## 5. External IO

- **HTTP**: plain global `fetch` works in plugin code — `dsh-mcp-connector/lib/{oauth,catalog,probe}.js` all call bare `fetch`. `ctx.web.fetch` is a *different*, policy-bounded service for model-facing retrieval (public destinations only, no credentials, 2048-char URL cap). Use `fetch` for Feishu/WPS/WeChat.
- **Processes**: `ctx.subprocess.spawn/resolveExecutable/spawnTerminal`, `ctx.shell`, and the model-facing bash tool are governed per call by `ctx.sandbox` — `read-only`, `workspace-write`, or `danger-full-access`; an unenforceable mode fails `SANDBOX_UNAVAILABLE` rather than running unconfined. Escalation goes through `ctx.approval.request`. Git: `ctx.worktrees.create(agent, request)` or shell out. Files: `ctx.fs.*`, sandbox-aware.

## 6. Images / vision

Content blocks are `{ type: 'image', … }` carrying a durable `ImageBlock` reference — **not** a data URL or bare path. Flow: `ctx.attachments.saveImage(input)`/`saveImages` → `ImageAttachmentRef`; `readImageRequest(ref, target, signal?)` → provider-shaped request image; text-only routes get placeholders (`textOnlyImageText`) — `dsh-llm/lib/types/content.js`. Tool results carry images natively: `read_image` returns "the image itself as a native image block" (`dsh-tool-fs__README.md:205`). Over the SDK wire pass `SdkEncodedImageBlock { type: "image", data, mimeType }`.

## 7. UI surface

A UI plugin adds `dsh.client` plus a `./client` export; the browser artifact calls `window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … } })` and returns `{ inject: ['slots'], apply(ctx) {…} }`. Canonical registration, verbatim from asar `dsh-client-ui-conversation/lib/client.js:17264`:

```js
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock', id: 'queue', order: 20,
  inject: (sessionId) => ({ /* per-session data */ })
}, QueueDock))
```

Slot keys from shipped bundles: `conversation.composer.dock`, `conversation.session.header`, `conversation.session.header.actions`, `conversation.chat.node`, `shell.bottom`, `shell.overlay`, `sidebar.right.pane.tab`, `sidebar.settings`. Render React inside a slot — **never** iframe a Host-served page; style only with `--dsw-alias-*` tokens; do not `require` other Harness client packages. For a full page there is also `ctx.betterSidebar.registerTab({ id, title, component })` (`dsh-better-sidebar/lib/types/client/service.d.ts:608`, `inject = ['betterSidebar']`).

## 8. Shipping

`package.json` needs `name`, `version`, `type:"module"`, `exports` (`.`, plus `./client`, `./icon`, `./locale/*.json` for UI), `files`, `dsh.bundle.patch`, optionally `dsh.client` and `engines.dsh`. Publish to npm, then `plugin_manager install_bundle`, or `dsh plugin --profile <p> add <pkg>@<ver>` (forwards to pnpm), or a market index over https registered via `pluginMarket.setIndexes` / sidebar **Plugins → Discover**. Outcomes: `failed`, `overridden`, `restart-required`; a *new* bundle can hot-activate, replacing an installed package needs a restart.

## What this means for my design

**Inside DSH (a plugin bundle):** the per-ticket agent invocation and the human surface. A Host plugin with `inject: ['timer','tools','fs','subprocess','storageDomain']` polls Feishu/WPS with `fetch` on a `ctx.timer.interval`, keeps row-hash state in `ctx.storageDomain`, and per changed row does `ctx.agents.create(...)` + `agent.followup(...)` + `whenIdle()` + `sessions.flush()` exactly as `dsh-headless` does — then shells out to `git`/`gh` under an explicit sandbox mode and POSTs the WeChat webhook. Expose `ticket_list`/`ticket_run` tools plus a composer dock badge or better-sidebar tab.

**Outside DSH (standalone Node service):** everything that must survive a DSH quit — polling, retry/backoff, dedupe, notification queue. `jobs` are in-process, `schedule` is session-bound and cannot mount without the Web Session controller, and the GUI may be closed. So run a Node watcher under Task Scheduler / `node-cron` that, per changed ticket, shells out to `dsh --profile headless --json "<prompt>"` with `DSH_HOME` and `DEEPSEEK_API_KEY` set, parses the NDJSON stream, and posts WeChat itself — no plugin install, survives upgrades, at the cost of one spawn per ticket and no shared session history.

**Recommended split:** the daemon owns the loop and the truth; the DSH plugin owns the human surface (panel, "run this now" tool, settings form) and reads the daemon's state file. If you insist on one artifact, build only the plugin and accept that polling stops whenever DSH is closed.

**Hard limits:** no durable job backend, no SQLite, no SDK client library, no cancel/close on the SDK protocol, `session/prompt` does not return the assistant answer, headless ignores GUI-stored credentials, and profile boot needs a writable `DSH_HOME`.
