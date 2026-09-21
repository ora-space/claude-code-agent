import type { HostProcesses, JsonValue } from "@ora-space/plugin-sdk";
import { spawnClaude } from "./command.ts";
import { logger } from "./log.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

const log = logger("claude-client");
/** The adapter's own stderr, republished line by line under its own target. */
const adapterLog = logger("claude-agent-acp");

/** The subset of a spawned child process this bridge depends on, so tests can substitute one. */
export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly pid: number | undefined;
  kill(): void;
  readonly exited: Promise<void>;
}

export interface ClaudeClientOptions {
  /**
   * Overrides process spawning; injected by tests. Production spawns through `attachProcesses`.
   *
   * Which program a spawn resolves to is `command.ts`'s decision and is deliberately not a
   * parameter here: this class owns the adapter's lifetime, not the question of where it lives.
   */
  spawn?: (cwd: string) => SpawnedProcess;
  /** Receives every ACP frame emitted by the adapter, in output order. */
  onAcpFrame?: (frame: JsonValue) => void;
  /** Invoked after the adapter exits on its own, never after an explicit stop. */
  onExited?: () => void;
}

interface RunningProcess {
  process: SpawnedProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Owns one `claude-agent-acp` subprocess and bridges ACP frames between its stdio and Ora.
 *
 * The adapter is a native ACP server: it takes no subcommand and no arguments, reads its initial
 * directory from the spawn cwd, and receives every per-session directory through ACP `session/new`.
 * The plugin owns its whole lifetime — spawn on `agent/start`, kill on `agent/stop`, respawn on an
 * Effect `reactivate` — so Ora never sees the child's stdio, which is what lets Claude Code use ACP
 * methods this host has never heard of. Nothing here parses ACP; frames are re-framed between Ora's
 * binary envelope and the adapter's NDJSON and otherwise passed through verbatim.
 */
export class ClaudeClient {
  readonly #spawn: (cwd: string) => SpawnedProcess | Promise<SpawnedProcess>;
  readonly #onAcpFrame: (frame: JsonValue) => void;
  readonly #onExited: () => void;
  /** Supplied by `attachProcesses` once the plugin's `Plugin` instance exists; see `main.ts`. */
  #processes: HostProcesses | undefined;
  #running: RunningProcess | undefined;
  #expectedExit = false;

  constructor(options: ClaudeClientOptions = {}) {
    this.#spawn = options.spawn ?? ((cwd) => this.#spawnViaHost(cwd));
    this.#onAcpFrame = options.onAcpFrame ?? (() => {});
    this.#onExited = options.onExited ?? (() => {});
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /**
   * Supplies the host-managed process client this plugin spawns `claude-agent-acp` through.
   *
   * Called once, from `onActivate`: the `Plugin` instance `createHostProcesses` needs does not
   * exist yet when this client is constructed as a class field, so production spawning stays
   * unavailable until this runs. Tests that inject `options.spawn` never need to call it.
   */
  attachProcesses(processes: HostProcesses): void {
    this.#processes = processes;
  }

  /**
   * Spawns the ACP adapter in the given working directory and starts bridging its stdio.
   *
   * Any previous child is stopped first so a restart cannot leave two adapters writing frames into
   * the same host connection.
   */
  async start(cwd: string): Promise<void> {
    const restarting = this.#running !== undefined;
    await this.stop();
    this.#expectedExit = false;

    log.info(restarting ? "restarting the adapter" : "starting the adapter", {
      context: { cwd },
    });
    // Failures are already classified for Ora by `spawnClaude`: an adapter this machine does not
    // have stays retryable, while a pin naming a missing executable says so by name.
    let process: SpawnedProcess;
    try {
      process = await this.#spawn(cwd);
    } catch (error) {
      log.warn("the adapter could not be spawned", { context: { cwd }, error });
      throw error;
    }
    this.#running = { process, stdinWriter: process.stdin.getWriter() };
    this.#attach(process);
    log.info("adapter running", { context: { cwd, pid: process.pid } });
  }

  /**
   * Forwards one host ACP frame into the adapter's stdin as NDJSON.
   *
   * Awaiting the write is what lets the adapter's backpressure reach the host instead of growing
   * an unbounded queue inside this process.
   */
  async writeAcp(frame: JsonValue): Promise<void> {
    const running = this.#running;
    if (running === undefined) {
      throw new Error("the Claude agent is not running");
    }
    try {
      await running.stdinWriter.write(encodeLine(JSON.stringify(frame)));
    } catch (error) {
      log.warn("writing an ACP frame to the adapter failed", {
        context: { pid: running.process.pid },
        error,
      });
      throw error;
    }
  }

  /** Kills the adapter and releases every pipe; idempotent when already stopped. */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    this.#expectedExit = true;
    if (running === undefined) {
      log.debug("stop requested with no adapter running");
      return;
    }
    log.info("stopping the adapter", { context: { pid: running.process.pid } });
    try {
      await running.stdinWriter.close();
    } catch {
      // The child already exited and closed its stdin; nothing is left to flush.
    }
    try {
      running.process.kill();
    } catch {
      // Already dead.
    }
  }

  /** Wires stdout, stderr, and exit bookkeeping for one live child. */
  #attach(process: SpawnedProcess): void {
    void this.#pumpStdout(process);
    void this.#pumpStderr(process);
    void process.exited.then(() => {
      // A process that is no longer `#running` was already superseded by a later `start()` (an
      // Effect restart, for instance); its death is old news, not a live agent going away, so it
      // must never clear the new process's tracking or fire `onExited` regardless of the shared
      // `#expectedExit` flag, which by then reflects the newer generation's intent, not this one's.
      if (this.#running?.process !== process) {
        log.debug("a superseded adapter generation exited", {
          context: { pid: process.pid },
        });
        return;
      }
      this.#running = undefined;
      if (this.#expectedExit) {
        log.info("adapter exited after stop", {
          context: { pid: process.pid },
        });
      } else {
        log.warn("claude-agent-acp exited unexpectedly", {
          context: { pid: process.pid },
        });
        this.#onExited();
      }
    });
  }

  /**
   * Forwards every NDJSON line the adapter prints as one ACP frame.
   *
   * A line that is not a JSON object is dropped with a warning rather than failing the bridge: Ora
   * rejects non-object frames anyway, and one stray diagnostic line must not end every live session
   * on this agent.
   */
  async #pumpStdout(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stdout)) {
        let frame: JsonValue;
        try {
          frame = JSON.parse(line) as JsonValue;
        } catch {
          // The line itself is logged: it is the adapter's own output on its protocol channel,
          // and the only clue to what went wrong with the pairing.
          log.warn("dropping a non-JSON stdout line from the adapter", {
            context: { pid: process.pid, line: line.slice(0, 512) },
          });
          continue;
        }
        if (
          frame === null || typeof frame !== "object" || Array.isArray(frame)
        ) {
          log.warn("dropping a non-object ACP frame from the adapter", {
            context: { pid: process.pid },
          });
          continue;
        }
        log.debug("adapter ACP frame received", {
          context: { pid: process.pid, ...summarize(frame) },
        });
        this.#onAcpFrame(frame);
      }
      log.debug("adapter stdout reached EOF", {
        context: { pid: process.pid },
      });
    } catch (error) {
      log.warn("claude-agent-acp stdout read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Republishes the adapter's diagnostics into this plugin's log, one record per line.
   *
   * The adapter is a third party whose stderr severity this plugin cannot know, so every line is
   * recorded at `info` under its own target rather than guessed at; the host's per-plugin level
   * decides whether it is kept.
   */
  async #pumpStderr(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stderr)) {
        if (line.length > 0) {
          adapterLog.info(line, { context: { pid: process.pid } });
        }
      }
    } catch (error) {
      log.warn("claude-agent-acp stderr read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Asks the host to spawn and own the adapter process, adapting its `HostChildProcess` handle
   * onto `SpawnedProcess` so every other method above stays unaware of who owns the OS process.
   */
  async #spawnViaHost(cwd: string): Promise<SpawnedProcess> {
    if (this.#processes === undefined) {
      throw new Error(
        "ClaudeClient cannot spawn before attachProcesses() runs",
      );
    }
    const child = await spawnClaude(this.#processes, { cwd });
    return {
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => child.write(chunk),
        close: () => child.closeStdin(),
      }),
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      // Best effort: the host already treats kill() as idempotent and tolerant of a process
      // that is already gone, so a rejection here is nothing callers need to observe.
      kill: () => void child.kill().catch(() => {}),
      exited: child.exited.then(() => undefined),
    };
  }
}

/** The envelope fields of one frame that are safe to log: never its params or result. */
function summarize(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return {};
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
  };
}
