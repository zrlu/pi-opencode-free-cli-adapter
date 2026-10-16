# pi-opencode-free-cli-adapter

A [Pi](https://pi.dev) extension that exposes the [OpenCode](https://opencode.ai)
CLI as a Pi model provider. It runs your existing `opencode` installation as a
local server, forwards the conversation to it, and translates its streaming
events back into Pi's assistant-message stream.

This is a CLI adapter, not a standalone model: it uses whatever providers,
models and credentials the `opencode` CLI is already configured with.

## How it works

- On each request, `server.ts` spawns `opencode serve` on a random loopback port
  with a per-request basic-auth password, waits for `/global/health`, creates a
  session, and subscribes to `/event`.
- The Pi conversation is flattened into a single OpenCode message (system prompt
  plus a role-tagged transcript of the prior messages) and posted to the session.
- OpenCode's `message.part.updated` / `message.part.delta` events are mapped into
  Pi `text` / `thinking` deltas. Token usage is accumulated from `step-finish`
  events.
- Interactive OpenCode `question.asked` events are surfaced through Pi's UI
  (`questions.ts`) and the answer is posted back; unanswered questions are
  rejected.
- The server process and session are cleaned up on abort, completion, or error.

## Requirements

- The `opencode` CLI available either as
  `~/node_modules/opencode-ai/bin/opencode.exe` (Windows) or `~/.bun/bin/opencode`.
- Pi.

## Install

```bash
pi install git:github.com/zrlu/pi-opencode-free-cli-adapter
```

Or copy this directory into
`~/.pi/agent/extensions/pi-opencode-free-cli-adapter/`.

## Configuring models

Installing this extension does **not** create any model entries on its own. It
only supplies the transport: `registerApiProvider` registers an API type named
`opencode-free-api` bound to the `local-opencode-free` provider. Nothing shows
up in Pi's model picker until you write a provider/model entry that references
that API.

So the division of labour is:

- **The adapter** provides *how to call* — the `opencode-free-api` API.
- **Your `models.json`** provides *what models exist* — the provider and model
  entries. Add them yourself.

Add a provider block to your Pi `models.json`. Only `api` is required; the rest
(`name`, `apiKey`, `models`, per-model flags) are ordinary Pi model-config
fields:

```json
{
  "providers": {
    "local-opencode-free": {
      "name": "OpenCode Free (local CLI)",
      "api": "opencode-free-api",
      "apiKey": "local",
      "models": [
        { "id": "deepseek-v4.1-flash-free", "name": "DeepSeek V4.1 Flash Free", "reasoning": true }
      ]
    }
  }
}
```

Notes:

- The `id` must match a model the `opencode` CLI itself can serve. The adapter
  carries no credentials of its own — it uses whatever the `opencode` CLI is
  already configured with.
- `apiKey` is a formality for the provider record. The adapter spawns its own
  loopback server with a per-request basic-auth password, so any non-empty
  placeholder works here; do not paste a real secret.
- Set `reasoning: true` only for models that support it.

## Name

`pi-opencode-free` was already taken on npm, hence the `-cli-adapter` suffix.
