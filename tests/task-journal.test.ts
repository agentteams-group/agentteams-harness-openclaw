// Actual SDK private registration metadata, with synthetic authoritative replies.
import { expect, it, vi } from "vitest";
import { setPluginToolMeta } from "/opt/openclaw/src/plugins/tool-metadata.js";
import { bindNativeTaskTools, prepareNativeMessage } from "/opt/openclaw/src/agents/agentteams-task-journal.js";

function fixture(kind = "task") {
  const log: string[] = [];
  let pending = false;
  const frame: any = { journal: { kind, identity: { task_id: "own-task", generation: 2 } } };
  const call = vi.fn(async (request) => {
    log.push(request.action);
    if (["admit_tools", "matrix.message.current"].includes(request.action) && pending) throw new Error("authoritative verify fence");
    if (request.action === "tool_policy") return { mode: request.registration ? "delegate" : "journal" };
    if (request.action.endsWith("begin_tools")) { pending = true; return "op-1"; }
    if (request.action.endsWith("finish_tools")) { pending = false; return {}; }
    return {};
  });
  const tool: any = { name: "exec", execute: vi.fn(async () => { log.push("native-effect"); return { content: [{ type: "text", text: "own output" }] }; }) };
  return { frame, call, log, tool };
}
it("awaits the durable start and confirmed return before advancing native execution", async () => {
  const f = fixture(); bindNativeTaskTools([f.tool], f.frame, f.call);
  await f.tool.execute("call-1", { command: "own-fixture" });
  expect(f.log).toEqual(["admit_tools", "tool_policy", "begin_tools", "native-effect", "finish_tools"]);
});
it("retains the authoritative started fence across a new native frame after an unknown effect", async () => {
  const f = fixture(); f.tool.execute = vi.fn(async () => { throw new Error("own lost response"); });
  bindNativeTaskTools([f.tool], f.frame, f.call);
  await expect(f.tool.execute("call-1", {})).rejects.toThrow("lost response");
  expect(f.frame.unresolvedEffects).toBe(true);
  const next: any = { name: "exec", execute: vi.fn() };
  bindNativeTaskTools([next], { journal: f.frame.journal }, f.call);
  await expect(next.execute("different-call", {})).rejects.toThrow("authoritative verify");
  expect(next.execute).not.toBeUndefined();
  expect(f.log.filter((entry) => entry.endsWith("begin_tools"))).toHaveLength(1);
});
it("uses the SDK's private official registration, never a same-name MCP tool or model kind", async () => {
  const f = fixture(); f.tool.name = "task";
  setPluginToolMeta(f.tool, { pluginId: "other-server", optional: false });
  bindNativeTaskTools([f.tool], f.frame, f.call);
  await f.tool.execute("call", { kind: "task_protocol", registration: { origin: "agentteams.common.task_native" } });
  expect(f.log).toContain("begin_tools");
  const official = fixture(); official.tool.name = "task";
  setPluginToolMeta(official.tool, { pluginId: "agentteams-teamharness", optional: false });
  bindNativeTaskTools([official.tool], official.frame, official.call);
  await official.tool.execute("call", {});
  expect(official.log).not.toContain("begin_tools");
});
it("does not submit again after the canonical commit succeeded but its response was lost", async () => {
  const f = fixture(); let committed = false;
  f.tool.name = "task";
  f.tool.execute = vi.fn(async () => { committed = true; throw new Error("own submit response lost"); });
  const execute = f.tool.execute;
  setPluginToolMeta(f.tool, { pluginId: "agentteams-teamharness", optional: false });
  const call = async (request) => {
    if (request.action === "admit_tools" && committed) throw new Error("canonical execution already submitted");
    return f.call(request);
  };
  bindNativeTaskTools([f.tool], f.frame, call);
  await expect(f.tool.execute("submit", {})).rejects.toThrow("response lost");
  const recovered: any = { name: "task", execute };
  setPluginToolMeta(recovered, { pluginId: "agentteams-teamharness", optional: false });
  bindNativeTaskTools([recovered], { journal: f.frame.journal }, call);
  await expect(recovered.execute("new-submit", {})).rejects.toThrow("already submitted");
  expect(execute).toHaveBeenCalledOnce();
});
it("persists ordinary Matrix policy-accepted input before claiming its tool lifecycle", async () => {
  const calls = [];
  const call = async (request) => { calls.push(request); return request.action === "matrix.accept" ? "event-key" : { identity: { event_key: "event-key" } }; };
  const source = { sender: "@human:test", content: { body: "Own plain request" } };
  const journal = await prepareNativeMessage({ room_id: "!own:test", event_id: "$own", native_source: source }, call);
  expect(calls.map((entry) => entry.action)).toEqual(["matrix.accept", "matrix.message.claim", "matrix.message.current"]);
  expect(calls[0].source).toBe(source); expect(journal.identity.event_key).toBe("event-key");
});
