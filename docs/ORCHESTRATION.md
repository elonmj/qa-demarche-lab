# Any orchestrator, selectable workers

The external orchestrator can be any LLM with process tools. It reads this repo's AGENTS.md, configures the target and chooses CLI workers independently of its own model. Example: GPT-6 Sol coordinates missions; Gemini Flash low explores; a declared reviewer checks evidence. The browser never belongs to the worker: it belongs to the factual engine.

## Clone and run

```sh
git clone https://github.com/elonmj/qa-demarche-lab.git
cd qa-demarche-lab
npm ci
npx playwright install chromium
npm run demo
cp examples/agents.codex.json site.json
```

Edit `origin`, exact safe reads, missions/personas and agents for your own staging site. Do not submit against arbitrary production data. Then:

```sh
node src/cli.mjs agents site.json
node src/cli.mjs explore site.json artifacts/my-campaign
```

Models are explicit CLI IDs. `low-gemini` is a worker name, not a universal model identifier. An absent executable/quota adapter/model stops the mission. CLI login is done explicitly by the user beforehand, using the vendor's normal login flow. The harness does not read/copy credentials, does not create accounts and does not buy credits.

## Supported adapters and evidence level

| Kind | Runtime | Quota | Status |
|---|---|---|---|
| `antigravity` | `agy` custom agent, JSONL, selected Gemini model, early tool-scope gate | Native `/usage`, typed windows and 15% reserve | Experimental: rejected on tested host (60 native tools, no gate attestation); do not bypass |
| `gemini` | Gemini CLI JSONL, one turn, core tools empty, system override, no MCP | Requires an explicit real `quotaCommand` adapter | Parser/process contracts tested; live Gemini CLI trial not claimed |
| `codex` | Codex exec JSONL, explicit model, read-only, shell disabled, no user config/MCP/web, ephemeral | Native `account/rateLimits/read` through app-server; optional real `quotaCommand` adapter | Two live synthetic decisions validated; campaign stopped at cumulative experiment cap |
| `json-cli` | Any trusted native CLI or Node wrapper, sanitized input stdin, one JSON decision stdout, `noTools:true` required | Explicit real quota reader | Process contract tested; wrapper isolation is integrator's responsibility |
| `json-gateway` | Cost-enforcing HTTP gateway | Gateway quota endpoint | HTTP contract tested; real gateway must enforce finance cap |

Windows npm `.cmd` shims are not executed through a shell. Gemini's standard global Node entrypoint is resolved when installed; custom wrappers should use a native executable (`node`, Python executable, etc.) and an argument array. Do not put shell strings, tokens or passwords in configuration.

Built-in CLI adapters currently require explicit **subscription** billing. `maxCostMicros:0` means no monetary reservation for an unpriced subscription request, not a zero-cost invoice. Calls/quota/reserve/deadline are enforced and reported; actual USD cost is unknown. For metered APIs use a gateway that enforces the cost bound. Internal vendor retries/telemetry may not map exactly to the process-call count: no financial certainty is claimed.

The `agents` object is an allowed registry. Every mission chooses its `agent` or the declared `defaultAgent`. Global calls and worker usage are persistent across missions/restarts. A provider error latches a circuit, preventing another model call and implicit fallback in that campaign; observations/reconciliation/reporting remain available.

Antigravity's reported native tool registry cannot be assumed empty from `tools:[]` alone. This adapter refuses before a model turn if tools are reported and its hard-deny gate is not already attested. The gate handler itself is tested, but its activation was not established on the tested CLI. This is a compatibility prerequisite, not a confirmed vendor vulnerability. Native CLI/user customizations are trusted local software; the harness does not certify host-level isolation. Windows may retain a temporary worker directory while the vendor language server holds it; cleanup failure is separate from the worker verdict.

## JSON-RPC stdio protocol

Start a child process:

```sh
node src/cli.mjs serve site.json artifacts/rpc-run
```

Send one JSON request per stdin line. Read one JSON reply per stdout line. No network listener, auth token, or endpoint file. The parent orchestrator owns the stream; commands execute serially. This is JSON-RPC, not an MCP server.

```json
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"observe"}
{"jsonrpc":"2.0","id":3,"method":"mission","params":{"scenario":"mobile-exploration","mode":"explore","limit":6}}
{"jsonrpc":"2.0","id":4,"method":"status"}
{"jsonrpc":"2.0","id":5,"method":"report"}
{"jsonrpc":"2.0","id":6,"method":"close"}
```

`mission` runs an authored scenario or bounded worker exploration. `step` runs a known authored step; previous preparations must be observed, and an attempted step cannot be replayed. `act` accepts an external orchestrator's decision with current `snapshotId/ref`, strictly read-only, with a persistent action cap (default 40). Its model cost belongs to the external orchestrator, not the harness's worker budget. `reconcile` only reads the independent probes of the submitted intent. Methods cannot alter config, grant permissions, raise budgets or read arbitrary files.

For writes use `step` against a reviewed authored scenario, never `act`. EOF closes the browser and saves a report. After process kill, verify process exit and unlock, then reconcile; authored preparation interrupted halfway requires review. A protocol error produces JSON error and preserves evidence. An error does not mean a previous submitted operation failed.

An authored submission must declare its browser action; it cannot ask the worker to invent the submitting gesture. Both RPC and direct Engine calls enforce observed preceding preparations in the current browser session. Mission roles apply before resolving controls and before independent probes. Configuration rejects normalized/ambiguous endpoint paths, overlapping safe-read/write scopes, duplicate write scopes, malformed assertions and unbounded timing/action caps before opening a run. No automatic migration of an existing campaign's configuration is performed.

## Current CLI references

Pour les nouvelles écritures, déclarer `scenario.operationId` et `probe.correlation = {path,op:"equals",value:operationId}` (ou `includes` sur une liste exacte de références). La lecture préalable doit être disponible et la référence absente ; le corps consenti doit utiliser cette même référence. `scope` est une annotation ; utiliser `scopeChecks` pour vérifier le compte/unité/date dans la réponse. Une mismatch de ces checks bloque un finding produit. Voir [migration, limites et preuves](ADVERSARIAL-REVIEW.md).

Après une interruption worker, `pendingWorker` n'autorise ni autre appel ni fallback. Ancienne configuration sans corrélation : `reconcile` et `report` restent disponibles, sans nouvelle soumission ; une preuve non corrélée ne devient pas un nouveau verdict confirmé. Les extensions d'adaptateurs reçoivent `{signal}` sur `quota`, `decide` et `probe`.

[Antigravity headless](https://www.antigravity.google/docs/cli/headless/), [Gemini headless](https://geminicli.com/docs/cli/headless/), [Gemini settings/tool allowlists](https://geminicli.com/docs/reference/configuration/), [Codex noninteractive](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli). Consulted 8 October 2026. Installed versions/flags differ; unsupported output or tool exposure fails closed. Model availability is verified by the owner's CLI/account, never silently substituted.
