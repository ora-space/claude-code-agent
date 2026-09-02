import {
  AGENT_NOT_INSTALLED,
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  HostRequestError,
  PluginMethodError,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";

/** The npm bin name of the ACP adapter that fronts Claude Code. */
const BINARY_NAME = "claude-agent-acp";

/**
 * Resolves the commands that can launch Claude Code's ACP adapter, in priority order.
 *
 * `ORA_CLAUDE_ACP_BIN` pins one exact binary and is returned alone: a pin that quietly fell back
 * to whatever is on PATH would run a different adapter than the user asked for, which is worse
 * than failing. Without a pin, Windows gets both spellings because npm installs only a
 * `claude-agent-acp.cmd` shim while a bun or standalone install exposes the bare name.
 */
export function resolveClaudeCommands(): string[] {
  const explicit = readEnv("ORA_CLAUDE_ACP_BIN")?.trim();
  if (explicit !== undefined && explicit !== "") {
    return [explicit];
  }
  return Deno.build.os === "windows"
    ? [`${BINARY_NAME}.cmd`, BINARY_NAME]
    : [BINARY_NAME];
}

/** Spawns the ACP adapter through Ora so host-owned MCP variables reach only this process. */
export function spawnClaude(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const explicit = readEnv("ORA_CLAUDE_ACP_BIN")?.trim();
  if (explicit === undefined || explicit === "") {
    return spawnAgentProcess(processes, {
      command: resolveClaudeCommands(),
    }, invocation);
  }
  return spawnOverride(processes, explicit, invocation);
}

/** Preserves the retryable missing-binary classification for an explicit developer override. */
async function spawnOverride(
  processes: HostProcesses,
  command: string,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  try {
    return await processes.spawn({ command, ...invocation });
  } catch (error) {
    if (
      error instanceof HostRequestError && error.kind === "program_not_found"
    ) {
      throw new PluginMethodError(
        AGENT_NOT_INSTALLED,
        `ORA_CLAUDE_ACP_BIN points at ${command}, which does not exist`,
      );
    }
    throw error;
  }
}

/** Classifies a spawn failure as a missing binary, tolerating platform error wording. */
export function isCommandNotFound(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /not found|cannot find|no such file|is not recognized/i.test(message);
}

/**
 * Runs `attempt` against every candidate command until one does not throw.
 *
 * Failures are classified on the way out: a failure that is not "binary missing" is the real
 * startup fault and is rethrown as-is, while an exhausted candidate list means the adapter is
 * simply absent. That distinction is the whole point — Ora retries `AGENT_NOT_INSTALLED` quietly
 * as expected local configuration, and logs anything else as a fault.
 */
export async function tryEachCandidate<T>(
  attempt: (command: string) => T | Promise<T>,
): Promise<T> {
  const candidates = resolveClaudeCommands();
  const failures: unknown[] = [];
  for (const command of candidates) {
    try {
      return await attempt(command);
    } catch (error) {
      failures.push(error);
    }
  }

  const realFailure = failures.find((error) => !isCommandNotFound(error));
  if (realFailure !== undefined) {
    throw realFailure instanceof Error
      ? realFailure
      : new Error(String(realFailure));
  }
  throw new PluginMethodError(
    AGENT_NOT_INSTALLED,
    `Claude Code's ACP adapter is not installed or not on PATH (tried: ${
      candidates.join(", ")
    }); install it with \`npm i -g @agentclientprotocol/claude-agent-acp\` or set ORA_CLAUDE_ACP_BIN`,
  );
}

/** Reads an env var, treating a missing read permission as an unset value. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // The host may not grant --allow-env; absence is indistinguishable from "not set".
    return undefined;
  }
}
