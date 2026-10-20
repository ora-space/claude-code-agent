import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  AgentModelContext,
  HostChildProcessOptions,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  claudeGatewayBase,
  claudeModelEnvironment,
  pinClaudeModelFrame,
  redactClaudeModelError,
} from "../src/services/model-adapter.ts";
import { AGENT_UNUSABLE, PluginMethodError } from "@ora-space/plugin-sdk";

Deno.test("model-mode error privacy keeps protocol classification available", () => {
  const token = context().token;
  const frame = redactClaudeModelError({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32601, message: token, data: { private: token } },
  });
  assertEquals(frame, {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32601, message: "Agent operation failed" },
  });
});
import { spawnClaudeModel } from "../src/services/command.ts";
import { ClaudeClient } from "../src/services/claude-client.ts";
import { startClaude } from "../src/handlers/lifecycle.ts";

/** Synthetic binding; no upstream credential or user profile is read by these tests. */
function context(): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.claude",
      pluginVersion: "1.0.0",
      target: Deno.build.target,
      packageSha256: "a".repeat(64),
      schemaVersion: 2,
      declarationFingerprint: "b".repeat(64),
      adapterVersion: 1,
      configurationRevision: 7,
      settingsJson: "{}",
      protocol: "anthropic-messages",
      model: {
        id: "vendor/model",
        name: "Frozen Model",
        contextWindow: 128000,
        maxTokens: 8192,
      },
    },
    proxyBaseUrl: "https://gateway.invalid/runtime/anthropic/v1",
    token: "synthetic-runtime-token",
  };
}

Deno.test("Claude pins every alias to the frozen model and keeps its token out of settings and ACP", () => {
  const frozen = context();
  const env = claudeModelEnvironment(frozen, "/private/execution");
  for (
    const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]
  ) assertEquals(env[name], "vendor/model");
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, frozen.token);
  assertEquals(
    claudeGatewayBase(frozen),
    "https://gateway.invalid/runtime/anthropic",
  );
  for (
    const method of [
      "session/new",
      "session/load",
      "session/resume",
      "session/fork",
    ]
  ) {
    const pinned = pinClaudeModelFrame(
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          cwd: "/project",
          _meta: {
            claudeCode: {
              options: {
                model: "other",
                settingSources: ["project"],
                env: {
                  ANTHROPIC_BASE_URL: "https://other.invalid",
                  ANTHROPIC_API_KEY: "stray-key",
                },
                settings: ".claude/settings.json",
                extraArgs: { settings: "other.json" },
              },
            },
          },
        },
      },
      frozen,
      "/private/execution",
    );
    const text = JSON.stringify(pinned);
    assertEquals(text.includes(frozen.token), false);
    assertEquals(text.includes("other.invalid"), false);
    assertEquals(text.includes("stray-key"), false);
    assertEquals(text.includes('"settingSources":[]'), true);
    assertEquals(text.includes('"model":"vendor/model"'), true);
    assertEquals(text.includes('"fallbackModel"'), false);
  }
});

Deno.test("Claude refuses provider replacement, another model and incompatible contexts", () => {
  const frozen = context();
  for (
    const method of [
      "authenticate",
      "logout",
      "providers/set",
      "providers/disable",
      "_auth/login",
    ]
  ) assertEquals(pinClaudeModelFrame({ id: 1, method }, frozen), undefined);
  assertEquals(
    pinClaudeModelFrame({
      id: 1,
      method: "session/set_model",
      params: { modelId: "other" },
    }, frozen),
    undefined,
  );
  assertEquals(
    pinClaudeModelFrame({
      id: 1,
      method: "session/set_config_option",
      params: { configId: "model", value: "other" },
    }, frozen),
    undefined,
  );
  const other = context();
  other.configuration.protocol = "openai-completions";
  assertThrows(
    () => claudeGatewayBase(other),
    Error,
    "claude_model_adapter_failed",
  );
  const invalid = context();
  invalid.proxyBaseUrl = "https://other.invalid/v1?token=private";
  assertThrows(
    () => claudeGatewayBase(invalid),
    Error,
    "claude_model_adapter_failed",
  );
});

Deno.test("the declared route names only the bundled adapter and cannot fall back to PATH", async () => {
  const calls: HostChildProcessOptions[] = [];
  const processes: HostProcesses = {
    spawn: (options) => {
      calls.push(options);
      return Promise.reject(new Error("absent package"));
    },
  };
  const error = await assertRejects(
    () => spawnClaudeModel(processes, { cwd: "/private" }),
    PluginMethodError,
  );
  assertEquals(error.code, AGENT_UNUSABLE);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.command, undefined);
  assertEquals(
    calls[0]?.packageCommand?.includes("assets/bin/claude-agent-acp"),
    true,
  );
});

Deno.test("startup acknowledges exact application and model changes never reach the child", async () => {
  const writes: JsonValue[] = [];
  const output = new TransformStream<Uint8Array>();
  const errors = new TransformStream<Uint8Array>();
  const frames: JsonValue[] = [];
  const exited = Promise.withResolvers<void>();
  const client = new ClaudeClient({
    spawn: () => ({
      stdin: new WritableStream({
        write: (chunk) => {
          writes.push(JSON.parse(new TextDecoder().decode(chunk)));
        },
      }),
      stdout: output.readable,
      stderr: errors.readable,
      pid: 7,
      kill: () => {
        void output.writable.close();
        void errors.writable.close();
        exited.resolve();
      },
      exited: exited.promise,
    }),
    onAcpFrame: (frame) => frames.push(frame),
  });
  const frozen = context();
  const applied = await startClaude(client, {
    cwd: "/private",
    hostVersion: "0",
    modelContext: frozen,
  });
  assertEquals(applied, {
    adapterVersion: 1,
    declarationFingerprint: "b".repeat(64),
    configurationRevision: 7,
  });
  assertEquals(client.frozenModel, {
    id: "vendor/model",
    displayName: "Frozen Model",
    default: true,
  });
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 1,
    method: "session/set_model",
    params: { modelId: "other" },
  });
  assertEquals(writes, []);
  assertEquals(frames, [{
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32602, message: "The execution model is frozen" },
  }]);
  await client.stop();
  await exited.promise;
});
