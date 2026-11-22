// Synthetic native state only; uses the actual shared receipt helper.
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "/opt/openclaw/src/agents/sessions/index.js";
import { guardSessionManager } from "/opt/openclaw/src/agents/session-tool-result-guard-wrapper.js";
import { withSessionManagerWrite } from "/opt/openclaw/src/agents/sessions/session-manager-write-admission.js";
import { checkpointTaskDeliveries, prepareTaskDeliveries, taskMiddlewareContext, checkpointCanonicalReceipts } from "/opt/openclaw/src/agents/agentteams-task-checkpoint.js";

afterEach(() => vi.restoreAllMocks());
const fact = "[Task system delivery record]\nOwn synthetic accepted report; no new request.";
function fixture() {
  const manager = guardSessionManager(SessionManager.inMemory());
  const session = { agent: { state: { messages: [] } } };
  const native = { manager, session, persist: (write) => withSessionManagerWrite(manager, write) };
  const frame = { deliveryRoom: "!own:test", deliveryFacts: [fact], deliveryAcknowledgements: { "$delivery": "!own:test" } };
  const context = { systemPrompt: fact, messages: [] };
  const call = vi.fn(async (request) => {
    expect(request.operation).toBe("ack_delivery_context");
    return JSON.parse(execFileSync("python3", ["-c", "import json,sys;sys.path.insert(0,'/opt/agentteams/plugins/teamharness/mcp/common');from task_receipt import ack_delivery_context;p=json.load(sys.stdin);ack_delivery_context(p['middle'],p['acknowledgements']);print(json.dumps(p['middle']))"],
      { encoding: "utf8", input: JSON.stringify(request) }));
  });
  return { manager, native, frame, context, call };
}
it("persists the actual visible delivery context and common acknowledgement in the native checkpoint", async () => {
  const f = fixture();
  await checkpointTaskDeliveries(f.frame, f.context, f.native, f.call);
  expect(f.call).toHaveBeenCalledOnce();
  expect(f.manager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(1);
  expect(f.manager.buildSessionContext().messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: fact }] });
  expect(f.context.messages).toEqual(f.native.session.agent.state.messages);
  expect(f.frame.deliveryAcknowledgements).toEqual({});
  expect(JSON.stringify(taskMiddlewareContext(f.manager))).toContain("$delivery");
});
it("does not acknowledge facts missing from the actual outgoing model context", async () => {
  const f = fixture(); f.context.systemPrompt = "unrelated";
  await checkpointTaskDeliveries(f.frame, f.context, f.native, f.call);
  expect(f.call).not.toHaveBeenCalled(); expect(f.manager.getEntries()).toHaveLength(0);
});
it("retains retry ownership after native persistence fails", async () => {
  const f = fixture(); f.native.persist = async () => { throw new Error("own disk fixture"); };
  await expect(checkpointTaskDeliveries(f.frame, f.context, f.native, f.call)).rejects.toThrow("disk fixture");
  expect(f.frame.deliveryAcknowledgements).toEqual({ "$delivery": "!own:test" });
  expect(f.call).not.toHaveBeenCalled();
});
it("deduplicates the persisted receipt after a post-commit interruption", async () => {
  const f = fixture(); const persist = f.native.persist;
  f.native.persist = async (write) => { await persist(write); throw new Error("own response interruption"); };
  await expect(checkpointTaskDeliveries(f.frame, f.context, f.native, f.call)).rejects.toThrow("interruption");
  f.native.persist = persist;
  await checkpointTaskDeliveries(f.frame, f.context, f.native, f.call);
  expect(f.manager.buildSessionContext().messages).toHaveLength(1);
  const read = vi.fn(async (request) => { expect(request.middle).toEqual(taskMiddlewareContext(f.manager)); return { facts: [], acknowledgements: {} }; });
  await prepareTaskDeliveries(f.frame, f.manager, read);
  expect(f.frame.deliveryFacts).toEqual([]);
});


it("persists common canonical receipts before actual model context and deduplicates retries", async () => {
  const f = fixture();
  const receipts = [{ receiptId: "public-receipt", fact: "Task system saved this exact plan." }];
  await checkpointCanonicalReceipts(receipts, f.context, f.native);
  await checkpointCanonicalReceipts(receipts, f.context, f.native);
  expect(f.manager.buildSessionContext().messages).toHaveLength(1);
  expect(f.context.messages).toEqual(f.native.session.agent.state.messages);
  expect(f.context.messages[0].content[0].text).toContain("saved tool result, not a new request");
});
it("does not expose a canonical receipt to the model when checkpoint persistence fails", async () => {
  const f = fixture(); f.native.persist = async () => { throw new Error("own storage fixture"); };
  await expect(checkpointCanonicalReceipts([{ receiptId: "public", fact: "saved" }], f.context, f.native)).rejects.toThrow("storage fixture");
  expect(f.context.messages).toEqual([]);
});
