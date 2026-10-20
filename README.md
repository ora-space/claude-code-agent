# ora-space.claude

An **agent plugin** for [Ora](https://github.com/ora-space) that adds
[Claude Code](https://claude.com/claude-code) as a selectable agent. Once
installed, Claude Code shows up in Ora's agent picker like any other agent —
pick it, and your conversation runs against the Claude Code CLI through its
[Agent Client Protocol](https://agentclientprotocol.com) adapter.

## What it does

- Publishes Claude Code as an agent inside Ora, alongside any other agent
  plugins you have installed.
- Starts and stops the Claude Code ACP adapter automatically as you switch
  agents — nothing to run by hand.
- Passes every model, session, and streaming feature Claude Code's adapter
  supports straight through to Ora's UI, including the in-session model picker
  (`default`, `sonnet`, `opus`, `haiku`, and Claude Fable).

## Requirements

- The Claude Code CLI, installed and authenticated (`claude`).
- The Claude ACP adapter on your `PATH`:
  ```
  npm i -g @agentclientprotocol/claude-agent-acp
  ```
  If you'd rather point at a specific binary instead of relying on `PATH`, set
  `ORA_CLAUDE_ACP_BIN` to its full path.

## Installing

Drop this plugin's folder into Ora's plugins directory
(`<ORA_DATA_DIR>/plugins/`) — Ora discovers any folder there with a
`package.json` automatically. Deleting the folder removes the agent again;
there's no other install step.

> **Note:** this plugin claims the same agent identity as Ora's built-in Claude
> Code support. Until that built-in support is removed, Ora will keep using its
> own copy and this plugin's copy will sit unused — installing it is safe, but
> it won't take over until the built-in one is retired.

## Using it

Once installed, open Ora, and select **Claude Code** from the agent picker.
Everything else — sessions, model selection, tool use — works the same as any
other agent in Ora.

## Project skills

Claude Code looks for reusable [Skills](https://agentclientprotocol.com) in a
`.claude/skills/<name>/SKILL.md` folder at the root of your project, alongside
any skills installed globally on your machine. Add or edit files there and Ora
takes care of getting Claude Code to pick them up — no manual restart needed.

## Configuration

| Variable             | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `ORA_CLAUDE_ACP_BIN` | Pin an exact path to the Claude ACP adapter binary, bypassing `PATH` lookup. |

## Platform model bindings

The SDK 0.11 startup contract can supply one frozen `modelContext`. This mode
requires the bundled adapter/native CLI pair and a private execution HOME from
the host. It uses only Anthropic Messages, pins the primary model and every
model alias, disables fallback, and overrides query settings sources and routing
before the first prompt. Discovery returns only the bound model. Legacy starts
omit the context and retain their existing behavior.

The temporary token is supplied only in the child environment. Programmatic
settings contain no token literal: the pinned SDK serializes them into CLI
arguments. Provider/authentication replacement and another model are refused;
private diagnostics are suppressed while protocol error codes remain intact.
Node owns renewal, revocation and process cleanup. Settings are validated JSON
text; this declaration currently contributes no additional options.

Declaration packaging remains an explicit `--agent-configuration` opt-in after
compatible hosts are deployed. Every target and the published static copy must
contain identical declaration bytes. Keep the default publication gate off
during host rollout.

## License

Apache-2.0
