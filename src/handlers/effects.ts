import type {
  AgentEffectCoordinationContext,
  AgentEffectDefinition,
  AgentEffectReadinessContext,
  EffectResourceDeclaration,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { PluginMethodError, SKILL_DIRECTORY_V1 } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";

/** The project Skill tree Claude Code reads when its adapter starts. */
export const SKILLS_RESOURCE: EffectResourceDeclaration = {
  workspaceRelativePath: ".claude/skills",
  materializationFormat: SKILL_DIRECTORY_V1,
  coordination: "quiesce_before_mutation",
};

const SESSION_PROMPT_METHOD = "session/prompt";
const CONSUMER_NOT_READY = -32000;
const QUIESCE_TIMEOUT_MS = 10_000;
const QUIESCE_POLL_MS = 50;

/** Coordinates both project Resources through one barrier and one adapter restart. */
export class AgentEffectCoordinator {
  readonly #client: ClaudeClient;
  readonly #cwd: () => string | undefined;
  readonly #openTurns = new Set<string | number>();
  #held: JsonValue[] | undefined;

  constructor(client: ClaudeClient, cwd: () => string | undefined) {
    this.#client = client;
    this.#cwd = cwd;
  }

  readonly definition: AgentEffectDefinition = {
    resources: [SKILLS_RESOURCE],
    coordinate: (context) => this.#coordinate(context),
    reactivate: (context) => this.#reactivate(context),
    verifyReady: (context) => this.#verifyReady(context),
  };

  /** Holds a new prompt behind the active Effect barrier. */
  intercept(frame: JsonValue): boolean {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return false;
    }
    const { method, id } = frame;
    if (
      method !== SESSION_PROMPT_METHOD ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    if (this.#held !== undefined) {
      this.#held.push(frame);
      return true;
    }
    this.#openTurns.add(id);
    return false;
  }

  /** Removes a completed prompt from the finite set the barrier must drain. */
  observe(frame: JsonValue): void {
    if (
      typeof frame !== "object" || frame === null || Array.isArray(frame) ||
      "method" in frame
    ) {
      return;
    }
    const { id } = frame;
    if (typeof id === "string" || typeof id === "number") {
      this.#openTurns.delete(id);
    }
  }

  /** Engages the barrier before waiting so new prompts cannot extend the drain indefinitely. */
  async #coordinate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    this.#held ??= [];
    const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
    while (this.#openTurns.size > 0) {
      if (Date.now() >= deadline) {
        const stranded = this.#openTurns.size;
        await this.#release();
        throw new PluginMethodError(
          CONSUMER_NOT_READY,
          `Claude Code still has ${stranded} turn(s) in flight`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, QUIESCE_POLL_MS));
    }
    return { targetId: context.targetId, state: "safe_to_mutate" };
  }

  /** Restarts once for the complete Target projection, then replays every held prompt in order. */
  async #reactivate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    if (this.#held === undefined) {
      return { targetId: context.targetId, state: "reactivated" };
    }
    const cwd = this.#cwd();
    if (cwd !== undefined) {
      await this.#client.start(cwd);
    }
    await this.#release();
    return { targetId: context.targetId, state: "reactivated" };
  }

  /** Proves the running adapter was started outside an unfinished projection episode. */
  #verifyReady(context: AgentEffectReadinessContext): JsonValue {
    if (!this.#client.running) {
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "the Claude adapter is not running, so project Effects are not loaded",
      );
    }
    if (this.#held !== undefined) {
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "Claude Code is quiesced for a project Effect mutation",
      );
    }
    return {
      targetId: context.targetId,
      generation: context.generation,
      consumerRevisionId: context.consumerRevisionId,
      projectionDigest: context.projectionDigest,
    };
  }

  /** Drains the live queue before lowering the barrier so a prompt cannot be stranded. */
  async #release(): Promise<void> {
    while (this.#held !== undefined && this.#held.length > 0) {
      const frame = this.#held.shift();
      if (frame !== undefined) {
        await this.#client.writeAcp(frame);
      }
    }
    this.#held = undefined;
  }
}
