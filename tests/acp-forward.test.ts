import { assertEquals } from "jsr:@std/assert@1";
import type { JsonValue } from "@ora-space/plugin-sdk";
import {
  AgentEffectCoordinator,
  SKILLS_RESOURCE,
} from "../src/handlers/effects.ts";
import { ClaudeClient } from "../src/services/claude-client.ts";

/** Secret-bearing stdio and HTTP servers the host injects through ACP. */
function mcpServers(): JsonValue[] {
  return [
    {
      type: "stdio",
      name: "ora-space/tavily-search",
      command: "/pkg/assets/server",
      args: ["."],
      env: [{ name: "TAVILY_API_KEY", value: "super-secret" }],
    },
    {
      type: "http",
      name: "ora-space/alpha-search",
      url: "https://mcp.example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer super-secret" }],
    },
  ];
}

Deno.test("registers only the Skill Effect Resource", () => {
  const effects = new AgentEffectCoordinator(
    new ClaudeClient(),
    () => undefined,
  );
  assertEquals(effects.definition.resources, [SKILLS_RESOURCE]);
});

Deno.test("does not intercept session/new mcpServers", () => {
  const effects = new AgentEffectCoordinator(
    new ClaudeClient(),
    () => undefined,
  );
  const frame = {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/workspace", mcpServers: mcpServers() },
  };
  assertEquals(effects.intercept(frame), false);
  assertEquals(frame.params.mcpServers, mcpServers());
});

Deno.test("does not intercept session/load mcpServers", () => {
  const effects = new AgentEffectCoordinator(
    new ClaudeClient(),
    () => undefined,
  );
  const frame = {
    jsonrpc: "2.0",
    id: 3,
    method: "session/load",
    params: {
      sessionId: "ses_1",
      cwd: "/workspace",
      mcpServers: mcpServers(),
    },
  };
  assertEquals(effects.intercept(frame), false);
  assertEquals(frame.params.mcpServers, mcpServers());
});
