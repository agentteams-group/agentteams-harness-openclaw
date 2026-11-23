// Awaited native tool execution binding to the shared authoritative journal.
import { spawn } from "node:child_process";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { AnyAgentTool } from "./tools/common.js";

type Frame = { journal?: { kind: "task" | "message"; identity: Record<string, unknown> };
  journalQueue?: Promise<void>; unresolvedEffects?: boolean };
type RPC = (request: Record<string, unknown>) => Promise<any>;
const originalExecutions = new WeakMap<AnyAgentTool, AnyAgentTool["execute"]>();

export const nativeRecoveryRPC: RPC = (request) => new Promise((resolve, reject) => {
  const child = spawn("python3", ["/opt/agentteams/scripts/lib/task_recovery_rpc.py"], {
    stdio: ["pipe", "pipe", "ignore"], timeout: 120000,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
  child.once("error", () => reject(new Error("Native recovery bridge unavailable")));
  child.once("close", (code) => {
    try {
      const reply = JSON.parse(output);
      if (code !== 0 || reply.error || !Object.hasOwn(reply, "value")) throw new Error("Unverified native recovery response");
      resolve(reply.value);
    } catch { reject(new Error("Native recovery requires authoritative verification")); }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));
});

export async function admitNativeTaskTools(frame: Frame | undefined, call: RPC = nativeRecoveryRPC) {
  if (!frame?.journal) return;
  if (frame.unresolvedEffects) throw new Error("Native tool outcome requires authoritative verification");
  const { kind, identity } = frame.journal;
  return await call({ action: kind === "task" ? "admit_tools" : "matrix.message.current", identity, runtime: "openclaw" });
}

export async function prepareNativeMessage(meta: Record<string, any>, call: RPC = nativeRecoveryRPC) {
  const event = await call({ action: "matrix.accept", runtime: "openclaw", room_id: meta.room_id,
    event_id: meta.event_id, source: meta.native_source, intent: "message" });
  const claimed = await call({ action: "matrix.message.claim", runtime: "openclaw", event_key: event });
  await call({ action: "matrix.message.current", runtime: "openclaw", identity: claimed.identity });
  return { kind: "message" as const, identity: claimed.identity };
}

export function bindNativeTaskTools(tools: AnyAgentTool[], frame?: Frame, call: RPC = nativeRecoveryRPC) {
  if (!frame?.journal) return tools;
  for (const tool of tools) {
    const execute = originalExecutions.get(tool) || tool.execute;
    originalExecutions.set(tool, execute);
    const meta = getPluginToolMeta(tool);
    // Ownership comes from the SDK's private WeakMap, never model arguments or
    // a similarly named tool from another MCP server.
    const registration = meta?.pluginId === "agentteams-teamharness" && !meta.mcp && tool.name === "task"
      ? { origin: "agentteams.common.task_native", entrypoint: "/opt/agentteams/plugins/teamharness/mcp/common/task_native.py" }
      : undefined;
    tool.execute = async (...args) => {
      const previous = frame.journalQueue || Promise.resolve();
      let release!: () => void;
      frame.journalQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        await admitNativeTaskTools(frame, call);
        const policy = await call({ action: "tool_policy", registration });
        if (policy.mode === "delegate") {
          try { return await execute(...args); }
          catch (error) { frame.unresolvedEffects = true; throw error; }
        }
        const { kind, identity } = frame.journal!;
        const prefix = kind === "task" ? "" : "matrix.message.";
        const operation = await call({ action: prefix + "begin_tools", runtime: "openclaw", identity,
          calls: [{ id: args[0], name: tool.name, arguments: args[1] }] });
        let result;
        try {
          result = await execute(...args);
          if (frame.unresolvedEffects) throw new Error("Native tool returned no verified outcome");
          await call({ action: prefix + "finish_tools", runtime: "openclaw", identity, operation_id: operation,
            results: [{ id: args[0], content: result.content, isError: result.isError === true }] });
        } catch (error) { frame.unresolvedEffects = true; throw error; }
        return result;
      } finally { release(); }
    };
  }
  return tools;
}
