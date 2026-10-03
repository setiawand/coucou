# coucou-agent

Runs one task with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and talks to Coucou in JSON lines. GitHub build only (the App Store sandbox cannot spawn Node). Needs Node 18+ and an Anthropic API key.

```sh
cd agent && npm install
ANTHROPIC_API_KEY=sk-ant-… node coucou-agent.mjs --cwd ~/work --max-turns 20 --max-budget 1 "your task"
```

## Protocol

stdout, one JSON object per line: `init`, `text`, `tool_use`, `permission_request`, `result`, `error`.
stdin, one JSON object per line: `{"type":"permission_response","id":"…","decision":"allow"|"deny"}` and `{"type":"cancel"}`.

## Safety

- `Read`, `Glob` and `Grep` run without asking. Everything else (Write, Edit, Bash…) emits a `permission_request` and waits for an explicit `allow`. No answer within 110 s means deny.
- Claude Code itself treats some simple read-only shell commands (for example `echo`) as safe and runs them without asking.
- `settingSources` is empty: `~/.claude/settings.json` (and its Coucou hooks) is not loaded, so events are not reported twice.
- `--max-turns` (default 20) and `--max-budget` in USD (default 1) bound every run.
- Per the Agent SDK terms, authenticate with an API key, not a claude.ai login.
