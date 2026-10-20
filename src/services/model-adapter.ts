import type { AgentModelContext, JsonValue } from "@ora-space/plugin-sdk";
import { join } from "@std/path";

/** A bounded failure never includes a credential, runtime token or third-party response. */
export function modelAdapterFailure(): Error {
  return new Error("claude_model_adapter_failed");
}

/** Validates the single Messages binding and derives the native SDK's endpoint prefix. */
export function claudeGatewayBase(context: AgentModelContext): string {
  const configuration = context.configuration;
  if (
    configuration.protocol !== "anthropic-messages" ||
    configuration.target !== Deno.build.target ||
    configuration.pluginId.split("/").at(-1) !== "ora-space.claude" ||
    /[\r\n]/.test(context.token)
  ) throw modelAdapterFailure();
  let settings: unknown;
  try {
    settings = JSON.parse(configuration.settingsJson);
  } catch {
    throw modelAdapterFailure();
  }
  if (!isObject(settings) || Object.keys(settings).length !== 0) {
    throw modelAdapterFailure();
  }
  let url: URL;
  try {
    url = new URL(context.proxyBaseUrl);
  } catch {
    throw modelAdapterFailure();
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.pathname !== "/runtime/anthropic/v1"
  ) throw modelAdapterFailure();
  url.pathname = "/runtime/anthropic";
  return url.toString().replace(/\/$/, "");
}

/** Host-owned child environment: authority stays in memory, never CLI arguments or settings files. */
export function claudeModelEnvironment(
  context: AgentModelContext,
  home = Deno.env.get("HOME") ?? "",
): Record<string, string> {
  const base = claudeGatewayBase(context);
  if (!home) throw modelAdapterFailure();
  const model = context.configuration.model.id;
  return {
    ORA_CLAUDE_PLATFORM_MODEL: "1",
    CLAUDE_CONFIG_DIR: join(home, ".claude-platform"),
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: context.token,
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_MODEL_CONFIG: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(
      context.configuration.model.maxTokens,
    ),
    DISABLE_NON_ESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
  };
}

/** Pins every query-creation path and refuses public calls that could replace the provider. */
export function pinClaudeModelFrame(
  frame: JsonValue,
  context: AgentModelContext,
  home = Deno.env.get("HOME") ?? "",
): JsonValue | undefined {
  if (!isObject(frame) || typeof frame.method !== "string") return frame;
  const method = frame.method;
  if (
    method === "authenticate" || method === "logout" ||
    method.startsWith("providers/") || method.startsWith("_auth/")
  ) return undefined;
  const params = isObject(frame.params) ? frame.params : {};
  const model = context.configuration.model.id;
  if (method === "session/set_model" && params.modelId !== model) {
    return undefined;
  }
  if (
    method === "session/set_config_option" && params.configId === "model" &&
    params.value !== model
  ) return undefined;
  if (
    !["session/new", "session/load", "session/resume", "session/fork"].includes(
      method,
    )
  ) return frame;
  const meta = isObject(params._meta) ? params._meta : {};
  const claude = isObject(meta.claudeCode) ? meta.claudeCode : {};
  const options = isObject(claude.options) ? claude.options : {};
  const lockedOptions = { ...options };
  // The pinned SDK rejects a fallback equal to the primary model; single-model runs disable it.
  delete lockedOptions.fallbackModel;
  const env = claudeModelEnvironment(context, home);
  // The SDK serializes programmatic settings into CLI arguments. The token must stay in env only.
  delete env.ANTHROPIC_AUTH_TOKEN;
  return {
    ...frame,
    params: {
      ...params,
      modelId: model,
      _meta: {
        ...meta,
        claudeCode: {
          ...claude,
          options: {
            ...lockedOptions,
            model,
            settingSources: [],
            env,
            settings: { apiKeyHelper: "", env },
            extraArgs: {},
            promptSuggestions: false,
          },
        },
      },
    },
  };
}

/** Preserves protocol error classification while dropping private provider diagnostics. */
export function redactClaudeModelError(frame: JsonValue): JsonValue {
  if (!isObject(frame) || !("error" in frame)) return frame;
  const candidate = isObject(frame.error) ? frame.error.code : undefined;
  const code = typeof candidate === "number" && Number.isInteger(candidate) &&
      candidate >= -2147483648 && candidate <= 2147483647
    ? candidate
    : -32603;
  return { ...frame, error: { code, message: "Agent operation failed" } };
}

/** Narrows only JSON objects; no untrusted value is rendered or executed. */
function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
