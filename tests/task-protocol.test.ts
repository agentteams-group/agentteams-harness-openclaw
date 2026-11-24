// Native SDK checkpoints on synthetic state only; never opens live sessions.
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "/opt/openclaw/src/agents/sessions/index.js";
import { guardSessionManager } from "/opt/openclaw/src/agents/session-tool-result-guard-wrapper.js";
import { withSessionManagerWrite } from "/opt/openclaw/src/agents/sessions/session-manager-write-admission.js";
import { resolveOpenClawPluginToolInputs } from "/opt/openclaw/src/agents/openclaw-tools.plugin-context.js";
import { buildAgentHookContext } from "/opt/openclaw/src/agents/harness/hook-context.js";
import { attachTaskProtocol, installTaskModelBoundary, taskProtocolCwd, taskNative } from "/opt/openclaw/src/agents/agentteams-task-protocol.js";
import { agentTeamsTraceAttrs, registerTaskTraceContext } from "/opt/openclaw/src/agents/agentteams-trace-context.js";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const manager = guardSessionManager(SessionManager.inMemory());
  const streamFn = vi.fn(async (_model, context) => context);
  const session = { agent: { state: { messages: [] }, streamFn } };
  const frame = { context: { inputRefreshPending: true }, pendingInputs: [{
    roomId: "!fixture:test", eventId: "$new", userId: "@human:test", body: "Own synthetic amendment",
  }] };
  const native = { session, manager, persist: (write) => withSessionManagerWrite(manager, write) };
  installTaskModelBoundary(frame, native);
  return { manager, streamFn, session, frame, native };
}

it("persists refreshed Human input as a native user message before the next model call", async () => {
  const f = fixture();
  const context = { messages: [] };
  await f.session.agent.streamFn({}, context, {});
  expect(f.frame.context.inputRefreshPending).toBe(false);
  expect(context.messages).toEqual(f.session.agent.state.messages);
  const saved = f.manager.buildSessionContext().messages;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "[Message $new]\nOwn synthetic amendment" }] });
  expect(saved[0].__openclaw.transport).toMatchObject({ channel: "matrix", messageId: "$new" });
  expect(f.streamFn).toHaveBeenCalledOnce();
});

it("does not call the model or clear the input fence when native persistence fails", async () => {
  const f = fixture();
  f.native.persist = async () => { throw new Error("own fixture disk full"); };
  await expect(f.session.agent.streamFn({}, { messages: [] }, {})).rejects.toThrow("disk full");
  expect(f.streamFn).not.toHaveBeenCalled();
  expect(f.frame.context.inputRefreshPending).toBe(true);
  expect(f.frame.pendingInputs).toHaveLength(1);
});

it("recovers an interrupted post-commit checkpoint without duplicating the Human message", async () => {
  const f = fixture();
  const persist = f.native.persist;
  f.native.persist = async (write) => { await persist(write); throw new Error("own fixture response lost"); };
  await expect(f.session.agent.streamFn({}, { messages: [] }, {})).rejects.toThrow("response lost");
  f.native.persist = persist;
  await f.session.agent.streamFn({}, { messages: [] }, {});
  expect(f.manager.buildSessionContext().messages).toHaveLength(1);
  expect(f.streamFn).toHaveBeenCalledOnce();
});

it("ends a completed protocol phase with its validated fact and no provider request", async () => {
  const f = fixture();
  f.frame.pendingInputs = [];
  f.frame.context.inputRefreshPending = false;
  Object.assign(f.frame, { finishedFact: "[Task system receipt]\nSaved submission; notification queued." });
  const stream = await f.session.agent.streamFn({ api: "openai-completions", provider: "fixture", id: "fixture" }, { messages: [] }, {});
  const result = await stream.result();
  expect(result.stopReason).toBe("stop");
  expect(result.content[0].text).toContain("notification queued");
  expect(f.streamFn).not.toHaveBeenCalled();
});

it("persists the actual sent fact before a silent terminal phase without another provider call", async () => {
  const f = fixture();
  f.frame.pendingInputs = [];
  f.frame.context.inputRefreshPending = false;
  Object.assign(f.frame, { finishedFact: "Saved submission", finishedDisplay: "NO_REPLY",
    terminalReceipts: [{ receiptId: "actual-send", fact: "[Task handoff receipt]\nActual Matrix send" }] });
  const result = await (await f.session.agent.streamFn({ api: "openai-completions", provider: "fixture", id: "fixture" }, { messages: [] }, {})).result();
  expect(result.content[0].text).toBe("NO_REPLY");
  expect(f.manager.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("Actual Matrix send"))).toBe(true);
  expect(f.streamFn).not.toHaveBeenCalled();
});

it("does not admit another model request while a native tool effect is unconfirmed", async () => {
  const f = fixture();
  Object.assign(f.frame, { unresolvedEffects: true });
  await expect(f.session.agent.streamFn({}, { messages: [] }, {})).rejects.toThrow("requires verification");
  expect(f.streamFn).not.toHaveBeenCalled();
  expect(f.frame.context.inputRefreshPending).toBe(true);
});

it("binds three independent native contexts without changing their Agent workspace", () => {
  const contexts = ["a", "b", "c"].map((id) => {
    const frame = { context: { execution: id }, prepared: { context: { outputDirectory: `/fixture/tasks/${id}/workspace` } } };
    const ctx = { WorkspaceDir: "/fixture/agent", GatewayRunToolBindings: { custom: "retained" } };
    attachTaskProtocol(ctx, frame);
    return ctx;
  });
  for (const [i, context] of contexts.entries()) {
    expect(context.WorkspaceDir).toBe("/fixture/agent");
    expect(context.GatewayRunToolBindings.custom).toBe("retained");
    expect(context.ChannelContext.chat.agentteamsTask).toBe(context.GatewayRunToolBindings.agentteamsTask);
    expect(taskProtocolCwd(context.GatewayRunToolBindings, "/fixture/agent")).toBe(`/fixture/tasks/${["a", "b", "c"][i]}/workspace`);
  }
  expect(taskProtocolCwd(undefined, "/fixture/agent")).toBe("/fixture/agent");
});

it("passes the same trusted frame through real SDK tool and prompt context construction", () => {
  const frame = { context: { execution: "own-task" } };
  const inbound: any = {};
  attachTaskProtocol(inbound, frame);
  const tool = resolveOpenClawPluginToolInputs({ options: {
    workspaceDir: "/fixture/agent", sessionId: "own-session", requesterAgentIdOverride: "main",
    toolBindings: inbound.GatewayRunToolBindings,
  }, resolvedConfig: { agents: { list: [{ id: "main", workspace: "/fixture/agent" }] } } });
  const prompt = buildAgentHookContext({ trigger: "user", sessionId: "own-session",
    channelContext: inbound.ChannelContext, senderId: "@human:fixture", chatId: "!room:fixture" });
  expect(tool.context.toolBindings?.agentteamsTask).toBe(frame);
  expect(prompt.channelContext?.chat?.agentteamsTask).toBe(frame);
  expect(tool.context.workspaceDir).toBe("/fixture/agent");
});

it("records only model-visible bound input identities without exporting Human text", async () => {
  vi.stubEnv("AGENTTEAMS_OTEL_ENABLED", "true");
  vi.stubEnv("AGENTTEAMS_WORKER_NAME", "own-trace-fixture");
  const f = fixture();
  f.frame.pendingInputs = [];
  Object.assign(f.frame.context, { inputRefreshPending: false, sources: [
    { eventId: "$first", inputId: "ref-first" }, { eventId: "$second", inputId: "ref-second" },
    { eventId: "$missing", inputId: "ref-missing" },
  ] });
  Object.assign(f.native, { runId: "own-diag-run", sessionKey: "own-chat" });
  Object.assign(f.frame, { systemContract: "Own public fixture contract", traceFields: {
    "agentteams.room.id": "!fixture:test", "agentteams.event.id": "$first",
  } });
  registerTaskTraceContext("own-chat", { "agentteams.event.id": "$stale" });
  const context = { systemPrompt: "Own public fixture contract\nref-first ref-missing", messages: [
    { role: "user", content: "[Message $first]\nprivate-fixture-body" },
    { role: "toolResult", content: [{ type: "text", text: "ref-second" }] },
    { role: "user", content: "[Message $second]\nprivate-fixture-amendment" },
  ] };
  await f.session.agent.streamFn({}, context, {});
  const fields = agentTeamsTraceAttrs({ runId: "own-diag-run", sessionKey: "own-chat", type: "model.call.started" });
  expect(fields["agentteams.input.event_ids"]).toEqual(["$first", "$second"]);
  expect(fields["agentteams.event.id"]).toBe("$first");
  expect(fields["langfuse.observation.type"]).toBe("generation");
  expect(fields["langfuse.trace.tags"]).toContain("room:!fixture:test");
  expect(JSON.parse(fields["agentteams.task.intake_checks"] as string)).toMatchObject({
    currentSystemContractPresent: true, providedInputs: 3, userSourceMarkers: 2, visibleInputReferences: 3,
  });
  expect(JSON.stringify(fields)).not.toContain("private-fixture-body");
  context.systemPrompt = "Unrelated contract";
  await f.session.agent.streamFn({}, context, {});
  expect(agentTeamsTraceAttrs({ runId: "own-diag-run" })["agentteams.input.event_ids"]).toEqual(["$first", "$second"]);
});


it("retains multibyte native bridge data across stdout chunks", async () => {
  const note = "汉字输入".repeat(25000);
  const result = await taskNative({ operation: "ack_delivery_context", middle: { note }, acknowledgements: {} });
  expect(result.note).toBe(note);
});


async function canonicalServer(reply: any, use: () => Promise<void>) {
  const server = createServer((request, response) => {
    expect(request.url).toBe("/api/v1/tasks/native-operations");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vi.stubEnv("AGENTTEAMS_CONTROLLER_URL", "http://127.0.0.1:" + address.port);
  vi.stubEnv("AGENTTEAMS_AUTH_TOKEN", "own-fixture");
  try { await use(); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
it("checks durable canonical phase admission before the actual native provider request", async () => {
  await canonicalServer({ mode: "verify", authority: { task: { id: "main", status: "in_progress" } } }, async () => {
    const f = fixture(); f.frame.pendingInputs = []; f.frame.context = { role: "leader", planning: ["main"] };
    await expect(f.session.agent.streamFn({}, { messages: [] }, {})).rejects.toThrow("authoritative verification");
    expect(f.streamFn).not.toHaveBeenCalled();
    expect(f.frame.unresolvedEffects).toBe(true);
  });
});
it("injects the shared cached receipt through native checkpoint before calling the provider", async () => {
  const result = { task: { id: "main", kind: "main", planId: "plan", status: "in_progress" }, progress: "pending", assignments: [] };
  await canonicalServer({ mode: "admitted", action: "plan", result }, async () => {
    const f = fixture(); f.frame.pendingInputs = []; f.frame.context = { role: "leader", planning: ["main"] };
    const context = { messages: [] };
    await f.session.agent.streamFn({}, context, {});
    expect(f.streamFn).toHaveBeenCalledOnce();
    const saved = f.manager.buildSessionContext().messages;
    expect(saved).toHaveLength(1);
    expect(saved[0].role).toBe("user");
    expect(saved[0].content[0].text).toContain("saved your execution plan");
    expect(context.messages).toEqual(f.native.session.agent.state.messages);
  });
});
