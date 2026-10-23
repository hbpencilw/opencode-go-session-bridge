# opencode-go-session-bridge

**A lightweight local bridge that makes OpenCode Go (Zen API) work with any coding agent.**

[简体中文](./README.md) | English

[![CI](https://github.com/hbpencilw/opencode-go-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hbpencilw/opencode-go-session-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](./package.json)

---

## The problem it solves

Since 2026-09-06, OpenCode Go ([docs](https://opencode.ai/docs/go/)) **requires every request to carry an `x-opencode-session` header** (used for session affinity and prompt-cache routing). Without it, the upstream rejects everything:

```
Reason: Failed to get response from the AI model; retried 5 times ...
Last error: 502 Request Failed: 400 {
  "type": "error",
  "error": {
    "type": "MissingSessionID",
    "message": "Request is missing x-opencode-session and cannot be routed efficiently."
  }
}
```

Many coding agents' custom-model channels (BYOK custom endpoints) never send that header — VS Code Copilot Chat, Trae, and others are affected (full list below). This bridge runs locally, **injects / preserves / repairs the `x-opencode-session` header**, and transparently forwards everything else.

```
your coding agent (VS Code / Trae / ...)
      │ HTTP (no session header)
      ▼
opencode-go-session-bridge (127.0.0.1:14731)
      │ inject/preserve x-opencode-session · self-identifying UA · pass-through Authorization
      ▼
https://opencode.ai/zen/go/v1/chat/completions
```

## Features

- **Zero third-party dependencies**: Node ≥ 18 standard library only, single file `proxy.mjs`;
- **Session strategy A–D** (see [How it works](#how-it-works)): pass-through → conversation-level derivation → body signal → per-model constant fallback (limitations documented honestly);
- **Streaming end to end**: SSE chunks pass through unbuffered and in order; `stream: false` supported too;
- **Transparent forwarding**: `tool_calls`, image fields, and error status codes round-trip untouched; the proxy itself never retries;
- **Secure defaults**: loopback-only binding, upstream whitelist (only `https://opencode.ai/zen/go/v1/*`), sanitized logging (never logs API keys / Authorization / request bodies / conversations);
- **Observability**: sanitized access log + `--capture` mode (structure and hashes only);
- **Trae name-clash workaround**: set the Model ID to a `proxy-<real-model>` alias and the bridge auto-strips the prefix before forwarding;
- **One-command daemon** (macOS): launchd-managed (start at login + auto-restart on crash).

## Quick start

```bash
# 1) Get it
git clone https://github.com/hbpencilw/opencode-go-session-bridge.git
cd opencode-go-session-bridge

# 2) Run (foreground; Ctrl+C to stop, or use the scripts)
node proxy.mjs                # listens on 127.0.0.1:14731 by default
node proxy.mjs --capture      # with sanitized capture log

# 3) Verify
./test.sh health              # local health check
./test.sh upstream            # proxy → upstream connectivity (GET /v1/models)
./test.sh text glm-5.3-flash  # keyless smoke test: a fake key should get 401
                              # (proves the session header passed upstream validation)

# 4) Point your client's custom model URL at the bridge:
#    http://127.0.0.1:14731/v1/chat/completions
```

To keep it running on macOS: `./scripts/install-launchagent.sh` (uninstall with `--uninstall`).

## Client setup

General rule: point the client's custom-model URL at `http://127.0.0.1:14731/v1/chat/completions`. API keys stay in the client's own secret storage (the proxy only forwards `Authorization` and never persists it).

| Client | Where to configure | Example |
|---|---|---|
| VS Code Copilot Chat | `chatLanguageModels.json` (BYOK customendpoint) | [examples/vscode-chatLanguageModels.example.json](./examples/vscode-chatLanguageModels.example.json) |
| Trae | Custom model dialog (OpenAI Chat Completions; URL `http://127.0.0.1:14731/v1`, keep "Full URL" off) | [examples/trae-custom-model.md](./examples/trae-custom-model.md) |
| Others (Claude Code / Codex / …) | Their custom model / Base URL settings | Same address |

⚠️ Client-side pitfalls (e.g. Trae's model-ID name-clash hijack; server-side-forwarded endpoints being unusable) are documented in [docs/compatibility.md](./docs/compatibility.md).

## How it works

Upstream contract: `x-opencode-session` may be any non-empty string, but must be **stable within a conversation, different across conversations, and contain no secrets**. The bridge derives it by priority:

| Level | Source | Behavior |
|---|---|---|
| A | Client already sends `x-opencode-session` | Passed through untouched |
| B | Request carries a stable conversation header (prefers `x-interaction-id`) | Deterministic `HMAC-SHA256(signal\|model)` → `vsc-<32hex>` |
| C | Non-content fields in the body (`user` / `metadata.*`) | Same derivation |
| D | Nothing available (fallback) | `HMAC("<unknown-window>"\|model)` |

Key points: the HMAC salt is persisted (`session-secret.key`, 0600 — a local HMAC salt only, **not** an upstream credential), so **mappings survive restarts** and existing conversations keep their cache affinity; the proxy **never reads prompt content to guess conversations**; no secret is ever used as session input.

Known limitation (documented honestly): clients that send no conversation-level header (e.g. Trae) fall back to level D — different conversations on the same model share one session ID. Details and real-traffic evidence: [docs/architecture.md](./docs/architecture.md).

## Compatibility

### ✅ Validated clients

| Client | Version | Provenance | Notes |
|---|---|---|---|
| VS Code GitHub Copilot Chat | 1.140 | **Verified in this project** (2026-10-10, 44 requests) | 3 models, 200/SSE end to end; `MissingSessionID` gone |
| Trae | 3.6.1 | **Verified in this project** (2026-10-10, 15 requests) | UA `hertz`; session falls back to level D |
| Hermes / Claude Code / Codex / ZCode / Pi / jcode / Kilo Code CLI | Official docs (Validated) | Native session header recognized by Go (minimum versions in [docs/compatibility.md](./docs/compatibility.md)) | Codex still drops the header in some versions/proxy setups — preserve it when forwarding |

### ⚠️ Known problematic clients (the reason this bridge exists)

| Client | Status | Tracking |
|---|---|---|
| DeepSeek Harness | Session header only reaches some model paths; native header identified, remaining work is sending it in all adapters | Discussion [#5495](https://github.com/anomalyco/opencode/discussions/5495) |
| GitHub Copilot Chat | Auto session-header support requested | VS Code issue [#334186](https://github.com/microsoft/vscode/issues/334186) |
| Kimi Code | Auto session-header support requested | issue [#3506](https://github.com/…/issues/3506) |
| MiMo Code | Proposed fix awaiting merge | issue [#2317](https://github.com/…/issues/2317) / PR [#2327](https://github.com/…/pull/2327) |

Full tables, client-side pitfalls, and account-level upstream limits (e.g. the DeepSeek "Global regions" gate) live in [docs/compatibility.md](./docs/compatibility.md).

## Configuration

No required configuration. Environment variables (see [.env.example](./.env.example)):

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_GO_PROXY_PORT` / `--port` | `14731` | Listen port (update client URLs if changed) |
| `OPENCODE_GO_PROXY_CAPTURE` / `--capture` | off | Sanitized capture log (capture.jsonl) |
| `OPENCODE_GO_PROXY_NO_INJECT` / `--no-inject` | off | Control group: do not inject the session header (for A/B verification) |
| `OPENCODE_GO_PROXY_HOME` | next to proxy.mjs | Data directory (salt/capture/log); **must live outside TCC-protected paths when launchd-managed** |

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` | Bridge not running | `./start.sh` |
| `400 MissingSessionID` | Traffic bypassed the bridge (wrong URL/port, Trae name clash) or injection failed | Check the URL; rerun `./test.sh text <model>` |
| `400 ... requires Global regions` | DeepSeek region gate (account setting) | opencode.ai console → Privacy → Global |
| `401/403 Invalid API key` | Invalid key | Check the client's key config |

More (log locations, launchd/TCC pitfalls, port changes, config rollback): [docs/troubleshooting.md](./docs/troubleshooting.md).

## Roadmap

- [ ] Verify more clients one by one and record them in compatibility.md (PRs welcome)
- [ ] Unit tests + extended CI (currently smoke tests)
- [ ] Optional `x-opencode-request` header (per-message counter observed in the official client)
- [ ] Log rotation (size cap + retention count)

## Contributing

Issues and PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE) © [hbpencilw](https://github.com/hbpencilw)
