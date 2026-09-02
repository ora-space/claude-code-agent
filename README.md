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
  `ORA_CLAUDE_ACP_BIN` to its full path. This release is validated against
  `claude-agent-acp` 0.64.0; other compatible versions are not rejected at
  runtime.

## Installing

Install the `.orax` artifact from the marketplace or build it locally with
`deno task package --tag v0.2.0 --repo ora-space/claude-code-agent`.

## Using it

Once installed, open Ora, and select **Claude Code** from the agent picker.
Everything else — sessions, model selection, tool use — works the same as any
other agent in Ora.

## Project skills

Claude Code looks for reusable [Skills](https://agentclientprotocol.com) in a
`.claude/skills/<name>/SKILL.md` folder at the root of your project, alongside
any skills installed globally on your machine. Add or edit files there and Ora
takes care of getting Claude Code to pick them up — no manual restart needed.

## Project MCP servers

Installed and configured MCP plugins are materialized into the project's
`.mcp.json`. Ora preserves user-owned servers, coordinates the file with the
Skill tree through one barrier, and restarts the adapter once after the whole
projection is current. Secret values stay in Ora's configuration store and are
injected only into the host-owned adapter process.

## Approval behavior

`claude-agent-acp` 0.64.0 exposes a fixed approval behavior through ACP. Ora
forwards it as-is; this plugin does not offer a separate permission-mode toggle
and does not claim that changing an Ora setting alters Claude Code approvals.

## Configuration

| Variable             | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `ORA_CLAUDE_ACP_BIN` | Pin an exact path to the Claude ACP adapter binary, bypassing `PATH` lookup. |

## License

Apache-2.0
