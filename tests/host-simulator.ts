/**
 * Drives the installed plugin exactly the way Ora's host does, against a real Claude ACP adapter.
 *
 * Run it with the same permissions Ora grants an agent plugin:
 *   deno run --allow-run --allow-read --allow-env --allow-net tests/host-simulator.ts
 */
const JSON_RPC_FRAME_TYPE = 0x01;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

/**
 * Encodes and decodes Ora's binary JSON-RPC frame envelope.
 *
 * This is a standalone reimplementation of the wire format, not an import from the plugin SDK:
 * this file plays the host's side of the protocol, and the host does not depend on the SDK it is
 * exercising.
 */

/** Encodes one JSON value into Ora's binary JSON-RPC frame envelope. */
function encodeFrame(message: JsonValue): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const length = payload.byteLength + 1;
  if (length > MAX_FRAME_LENGTH) {
    throw new Error(`Plugin frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }

  const frame = new Uint8Array(length + 4);
  new DataView(frame.buffer).setUint32(0, length, false);
  frame[4] = JSON_RPC_FRAME_TYPE;
  frame.set(payload, 5);
  return frame;
}

/** Decodes arbitrarily fragmented bytes into complete JSON-RPC messages. */
async function* decodeFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  let buffer = new Uint8Array();
  for await (const chunk of readable) {
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    combined.set(buffer);
    combined.set(chunk, buffer.byteLength);
    buffer = combined;

    while (buffer.byteLength >= 4) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).getUint32(0, false);
      if (length < 1 || length > MAX_FRAME_LENGTH) {
        throw new Error(`Invalid plugin frame length ${length}`);
      }
      if (buffer.byteLength < length + 4) {
        break;
      }
      if (buffer[4] !== JSON_RPC_FRAME_TYPE) {
        throw new Error(`Unsupported plugin frame type ${buffer[4]}`);
      }

      const payload = buffer.slice(5, length + 4);
      buffer = buffer.slice(length + 4);
      yield JSON.parse(new TextDecoder().decode(payload));
    }
  }

  if (buffer.byteLength !== 0) {
    throw new Error("Plugin protocol stream ended inside a frame");
  }
}

const HOST_PERMISSIONS = [
  "--no-prompt",
  "--allow-run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
];

/** Converts this module-relative URL into a host path, including a Windows drive prefix. */
const entrypoint = decodeURIComponent(
  new URL("../src/main.ts", import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, "$1");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", ...HOST_PERMISSIONS, entrypoint],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const send = (message: JsonValue) => writer.write(encodeFrame(message));
const inbound = decodeFrames(child.stdout)[Symbol.asyncIterator]();

interface SimulatedChildProcess {
  child: Deno.ChildProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

const simulatedProcesses = new Map<string, SimulatedChildProcess>();
let nextProcessId = 1;
let adapterSpawns = 0;

/** Recognizes requests the sandboxed plugin delegates to its host. */
function isChildProcessRequest(message: Record<string, unknown>): boolean {
  return typeof message.method === "string" &&
    message.method.startsWith("ora/childprocess/") && message.id !== undefined;
}

/** Serves the host-owned child-process subset used by this Agent. */
async function handleChildProcessRequest(
  message: Record<string, unknown>,
): Promise<void> {
  const params = (message.params ?? {}) as Record<string, unknown>;
  try {
    let result: JsonValue;
    switch (message.method) {
      case "ora/childprocess/spawn": {
        const requestedEnvironment = (params.env ?? {}) as Record<
          string,
          string
        >;
        if (
          Object.keys(requestedEnvironment).some((key) =>
            key.startsWith("ORA_MCP_")
          )
        ) {
          throw new Error(
            "the plugin attempted to set a reserved MCP variable",
          );
        }
        const spawned = new Deno.Command(params.command as string, {
          args: (params.args as string[] | undefined) ?? [],
          cwd: (params.cwd as string | undefined) ?? undefined,
          env: {
            ...requestedEnvironment,
          },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const processId = String(nextProcessId++);
        adapterSpawns += 1;
        simulatedProcesses.set(processId, {
          child: spawned,
          stdinWriter: spawned.stdin.getWriter(),
        });
        void pumpChild(processId, spawned.stdout, "ora/childprocess/stdout");
        void pumpChild(processId, spawned.stderr, "ora/childprocess/stderr");
        void spawned.status.then(async (status) => {
          simulatedProcesses.delete(processId);
          await send({
            jsonrpc: "2.0",
            method: "ora/childprocess/exit",
            params: { processId, code: status.code, signal: null },
          }).catch(() => {});
        });
        result = { processId, pid: spawned.pid };
        break;
      }
      case "ora/childprocess/write": {
        const running = simulatedProcesses.get(params.processId as string);
        if (running === undefined) throw new Error("unknown processId");
        const binary = atob(params.bytesBase64 as string);
        await running.stdinWriter.write(
          Uint8Array.from(binary, (char) => char.charCodeAt(0)),
        );
        result = {};
        break;
      }
      case "ora/childprocess/close_stdin": {
        await simulatedProcesses.get(params.processId as string)?.stdinWriter
          .close();
        result = {};
        break;
      }
      case "ora/childprocess/kill": {
        simulatedProcesses.get(params.processId as string)?.child.kill();
        result = {};
        break;
      }
      default:
        throw new Error(`unsupported host method ${message.method}`);
    }
    await send({ jsonrpc: "2.0", id: message.id as number, result });
  } catch (error) {
    await send({
      jsonrpc: "2.0",
      id: message.id as number,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
        data: { kind: "io" },
      },
    });
  }
}

/** Relays one child stream through the same base64 notifications Ora uses. */
async function pumpChild(
  processId: string,
  stream: ReadableStream<Uint8Array>,
  method: string,
): Promise<void> {
  for await (const bytes of stream) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await send({
      jsonrpc: "2.0",
      method,
      params: { processId, bytesBase64: btoa(binary) },
    }).catch(() => {});
  }
}

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await inbound.next();
    if (next.done) {
      throw new Error(`plugin closed stdout while waiting for ${label}`);
    }
    const message = next.value as Record<string, unknown>;
    if (isChildProcessRequest(message)) {
      void handleChildProcessRequest(message);
      continue;
    }
    if (match(message)) {
      return message;
    }
    console.log(`[host] << ${JSON.stringify(message).slice(0, 160)}`);
  }
}

/** Fails the run loudly instead of letting a wrong answer read as a passing line. */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`check failed: ${label}`);
  }
}

const acpFrame = (message: Record<string, unknown>): Record<string, unknown> =>
  (message.params ?? {}) as Record<string, unknown>;

const register = await waitFor(
  (message) => message.method === "ora/register",
  "ora/register",
);
const registration = register.params as {
  methods: string[];
  emits: string[];
  effectResources: Record<string, unknown>[];
};
for (const method of ["agent/start", "agent/stop", "agent/list_models"]) {
  check(registration.methods.includes(method), `registers ${method}`);
}
check(registration.emits.includes("agent/acp"), "emits agent/acp");
const resourceSignatures = registration.effectResources.map((resource) =>
  `${resource.workspaceRelativePath}:${resource.materializationFormat}`
).sort();
check(
  JSON.stringify(resourceSignatures) === JSON.stringify([
    ".claude/skills:ora/skill-directory.v1",
  ]),
  "declares the Skill Resource",
);
console.log(`ok: register ${JSON.stringify(register.params)}`);

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "agent/start",
  params: { cwd: Deno.cwd(), hostVersion: "0.8.0" },
});
const started = await waitFor((message) => message.id === 1, "agent/start");
check(
  JSON.stringify(started.result) === JSON.stringify({
    protocol: "acp",
    acpVersion: 1,
  }),
  "agent/start returns the ACP protocol descriptor",
);
console.log(
  `ok: agent/start ${JSON.stringify(started.result ?? started.error)}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  },
});
const initialized = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 1,
  "ACP initialize",
);
const initializeResult = acpFrame(initialized).result as {
  protocolVersion?: number;
  agentInfo?: { name?: string };
};
check(initializeResult?.protocolVersion === 1, "ACP protocol version is 1");
console.log(
  `ok: initialize ${initializeResult?.agentInfo?.name} protocolVersion ${initializeResult?.protocolVersion}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const session = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 2,
  "ACP session/new",
);
const sessionResult = acpFrame(session).result as {
  sessionId?: string;
  configOptions?: { id: string; category?: string; options?: unknown[] }[];
} | undefined;
check(
  typeof sessionResult?.sessionId === "string",
  "session/new returns an id",
);
// The model list lives here and nowhere else, which is why `agent/listModels` is empty below.
const modelOption = sessionResult?.configOptions?.find(
  (option) => option.category === "model",
);
check(modelOption !== undefined, "session/new carries a model config option");
console.log(
  `ok: session/new ${sessionResult?.sessionId} models via ACP: ${
    JSON.stringify(
      modelOption?.options?.map((o) => (o as { value: string }).value),
    )
  }`,
);

await send({ jsonrpc: "2.0", id: 2, method: "agent/list_models", params: {} });
const models = await waitFor(
  (message) => message.id === 2,
  "agent/list_models",
);
const modelList = ((models.result ?? {}) as { models?: unknown[] }).models;
check(
  Array.isArray(modelList) && modelList.length === 0,
  "agent/listModels is empty because Claude has no pre-session model list",
);
console.log("ok: listModels [] (Claude publishes models through ACP only)");

const coordination = {
  targetId: "sim-target",
  resourceIds: ["sim-skills"],
};
await send({
  jsonrpc: "2.0",
  id: 3,
  method: "effect/coordinate",
  params: coordination,
});
check(
  (await waitFor((message) => message.id === 3, "effect/coordinate")).error ===
    undefined,
  "coordinates the Skill Resource",
);
await send({
  jsonrpc: "2.0",
  id: 4,
  method: "effect/reactivate",
  params: coordination,
});
check(
  (await waitFor((message) => message.id === 4, "effect/reactivate")).error ===
    undefined,
  "reactivates after the shared projection",
);
check(adapterSpawns === 2, "performs one initial spawn and one shared restart");

await send({ jsonrpc: "2.0", id: 5, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 5, "agent/stop");
console.log("ok: agent/stop");

await send({ jsonrpc: "2.0", method: "ora/shutdown" });
await writer.close();
const status = await child.status;
console.log(`plugin exited with code ${status.code}`);
console.log(
  status.success
    ? "ALL HOST SIMULATION CHECKS PASSED"
    : "PLUGIN EXITED NON-ZERO",
);
Deno.exit(status.success ? 0 : 1);
