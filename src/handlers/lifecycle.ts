import type { AgentStartContext } from "@ora-space/plugin-sdk";
import { INVALID_PARAMS, PluginMethodError } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";
import { logger } from "../services/log.ts";

const log = logger("lifecycle");

/**
 * Serves `agent/start` by bringing the Claude ACP adapter up in the host's working directory.
 *
 * Ora calls this once per connection, before any session exists, so the adapter is already
 * accepting ACP frames when the host runs its own `initialize` handshake. Per-session directories
 * travel later in ACP `session/new`, not here.
 */
export async function startClaude(
  client: ClaudeClient,
  context: AgentStartContext,
): Promise<void> {
  if (context.cwd.trim() === "") {
    log.warn("agent/start refused: empty cwd");
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/start requires a non-empty cwd",
    );
  }
  await client.start(context.cwd);
  log.info("Claude ACP adapter started for agent/start", {
    context: { cwd: context.cwd },
  });
}

/**
 * Serves `agent/stop` by killing the adapter while keeping this plugin process alive.
 *
 * A later `agent/start` respawns it, which is what lets Ora restart a failed agent without paying
 * for a new plugin handshake.
 */
export async function stopClaude(client: ClaudeClient): Promise<void> {
  const wasRunning = client.running;
  await client.stop();
  log.info("Claude ACP adapter stopped for agent/stop", {
    context: { wasRunning },
  });
}
