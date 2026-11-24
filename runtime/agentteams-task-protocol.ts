// Native Matrix/SDK IO binding. All Task semantics remain in the common bridge.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { buildUsageWithNoCost } from "./stream-message-shared.js";
import { admitNativeTaskTools, prepareNativeMessage } from "./agentteams-task-journal.js";
import { checkpointTaskDeliveries, checkpointCanonicalReceipts } from "./agentteams-task-checkpoint.js";
import { registerTaskTraceContext } from "./agentteams-trace-context.js";

export type TaskProtocolFrame = {
  context: Record<string, any>;
  prepared?: Record<string, any>;
  deliveryRoom?: string;
  deliveryFacts?: string[];
  deliveryAcknowledgements?: Record<string, string>;
  inputCheckpointAvailable?: boolean;
  pendingInputs?: Array<Record<string, any>>;
  finishedFact?: string;
  finishedDisplay?: string;
  terminalReceipts?: Array<{ receiptId: string; fact: string }>;
  unresolvedEffects?: boolean;
  systemContract?: string;
  traceFields?: Record<string, string | number | boolean | string[]>;
  roster?: Record<string, unknown>;
  journal?: { kind: "task" | "message"; identity: Record<string, unknown> };
  journalQueue?: Promise<void>;
};

export function installTaskModelBoundary(frame: TaskProtocolFrame | undefined, native: {
  session: any; manager: any; persist: (write: () => Promise<void>) => Promise<void>;
  runId?: string; sessionKey?: string;
}) {
  if (!frame) return;
  frame.inputCheckpointAvailable = true;
  const next = native.session.agent.streamFn;
  native.session.agent.streamFn = async (model: any, context: any, options: any) => {
    if (frame.unresolvedEffects) throw new Error("Native tool outcome requires verification before another model call");
    const pending = frame.pendingInputs || [];
    if (!pending.length && frame.context.inputRefreshPending) throw new Error("Verified Human inputs await native checkpoint");
    const admitted: any[] = [];
    if (pending.length) {
      await native.persist(async () => {
        for (const source of pending) {
          const key = "agentteams:matrix:" + JSON.stringify([source.roomId, source.eventId]);
          let message = native.manager.buildSessionContext().messages.find((m: any) => m.idempotencyKey === key);
          if (!message) {
            message = { role: "user", content: [{ type: "text", text: "[Message " + source.eventId + "]\n" + source.body }],
              timestamp: Date.now(), idempotencyKey: key, __openclaw: { senderId: source.userId,
                transport: { channel: "matrix", messageId: source.eventId } } };
            await native.manager.appendMessageAsync(message);
          }
          message = native.manager.buildSessionContext().messages.find((m: any) => m.idempotencyKey === key);
          const content = typeof message?.content === "string" ? message.content
            : (message?.content || []).map((part: any) => part.text || "").join("\n");
          if (message?.role !== "user" || message.__openclaw?.transport?.messageId !== source.eventId
              || message.__openclaw?.senderId !== source.userId || content !== "[Message " + source.eventId + "]\n" + source.body) {
            throw new Error("Native SDK did not retain the verified Human input");
          }
          admitted.push(message);
        }
        native.manager.flushPendingPersistence();
      });
      for (const messages of [native.session.agent.state.messages, context.messages]) {
        for (const message of admitted) {
          if (!messages.some((m: any) => m.idempotencyKey === message.idempotencyKey)) messages.push(message);
        }
      }
      frame.pendingInputs = [];
      frame.context.inputRefreshPending = false;
    }
    await checkpointTaskDeliveries(frame, context, native, taskNative);
    if (frame.finishedFact) {
      await checkpointCanonicalReceipts(frame.terminalReceipts || [], context, native);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: { role: "assistant",
        content: [{ type: "text", text: frame.finishedDisplay ?? frame.finishedFact }], api: model.api, provider: model.provider,
        model: model.id, usage: buildUsageWithNoCost({}), stopReason: "stop", timestamp: Date.now() } });
      return stream;
    }
    const admission = await admitNativeTaskTools(frame);
    const receipts = [...(admission?.receipts || [])];
    if (frame.journal?.kind !== "task" && process.env.AGENTTEAMS_CONTROLLER_URL) {
      const canonical = await taskNative({ operation: "canonical_admit", context: frame.context });
      if (canonical.ok !== true) {
        frame.unresolvedEffects = true;
        throw new Error("Canonical Task outcome requires authoritative verification before model admission");
      }
      receipts.push(...(canonical.receipts || []));
    }
    await checkpointCanonicalReceipts(receipts, context, native);
    if (native.runId && process.env.AGENTTEAMS_OTEL_ENABLED === "true") {
      const text = (message: any) => typeof message.content === "string" ? message.content
        : (message.content || []).map((part: any) => part.text || "").join("\n");
      const userText = context.messages.filter((message: any) => message.role === "user").map(text);
      const visibleText = context.messages.map(text);
      const system = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
      const contract = frame.systemContract || "";
      const contractPresent = Boolean(contract) && system.includes(contract);
      const sources = frame.context.sources || [];
      const markers = sources.filter((source: any) => userText.some((text: string) => text.includes("[Message " + source.eventId + "]")));
      const references = sources.filter((source: any) => system.includes(source.inputId)
        || visibleText.some((text: string) => text.includes(source.inputId)));
      const admitted = sources.filter((source: any) => contractPresent && markers.includes(source) && references.includes(source));
      registerTaskTraceContext(native.runId, { ...frame.traceFields,
        "agentteams.input.event_ids": admitted.map((source: any) => source.eventId),
        "agentteams.task.intake_checks": JSON.stringify({
          contractHash: createHash("sha256").update(contract).digest("hex").slice(0, 16),
          currentSystemContractPresent: contractPresent, providedInputs: sources.length,
          userSourceMarkers: markers.length, visibleInputReferences: references.length,
        }),
      }, true);
    }
    return next(model, context, options);
  };
}

export function attachTaskProtocol(context: Record<string, any>, frame?: TaskProtocolFrame) {
  if (!frame) return;
  if (context.SessionKey && frame.traceFields) registerTaskTraceContext(context.SessionKey, frame.traceFields);
  context.GatewayRunToolBindings = { ...context.GatewayRunToolBindings, agentteamsTask: frame };
  context.ChannelContext = { ...context.ChannelContext,
    chat: { ...context.ChannelContext?.chat, agentteamsTask: frame } };
  if (frame.context.sources?.length && typeof context.BodyForAgent === "string") {
    const marker = "[Message " + frame.context.sourceEvent + "]";
    if (!context.BodyForAgent.startsWith(marker)) context.BodyForAgent = marker + "\n" + context.BodyForAgent;
  }
}

export function taskProtocolCwd(bindings: Readonly<Record<string, unknown>> | undefined, fallback: string) {
  const frame = bindings?.agentteamsTask as TaskProtocolFrame | undefined;
  return frame?.prepared?.context?.outputDirectory || fallback;
}

export function taskNative<T = any>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["/opt/agentteams/plugins/teamharness/mcp/common/task_native.py"], {
      stdio: ["pipe", "pipe", "ignore"], timeout: 120000,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.once("error", () => reject(new Error("Native Task bridge unavailable")));
    child.once("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (code !== 0) reject(new Error(result.message || "Native Task operation failed"));
        else resolve(result);
      } catch { reject(new Error("Native Task bridge returned no verified JSON result")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function prepareTaskProtocol(meta: Record<string, any>): Promise<TaskProtocolFrame | undefined> {
  if (!process.env.AGENTTEAMS_CONTROLLER_URL) return;
  const role = process.env.AGENTTEAMS_AGENT_ROLE || "worker";
  let event = meta.teamharness_coordination;
  const frame: TaskProtocolFrame = { context: { role, sourceEvent: meta.event_id, actor: meta.agent_matrix_user_id }, traceFields: {
    "agentteams.room.id": meta.room_id,
    ...(meta.event_id?.startsWith("$") ? { "agentteams.event.id": meta.event_id } : {}),
    "agentteams.task.phase": event?.kind || "source_request",
    ...(event?.id ? { "agentteams.coordination.id": event.id } : {}),
    ...(event?.kind ? { "agentteams.coordination.kind": event.kind } : {}),
  } };
  if (event) {
    if (["handoff", "task_submitted", "main_task_ready"].includes(event.kind)) {
      const admission = await taskNative({ operation: "admit_event", eventId: event.id, nativeEventId: meta.event_id });
      if (admission.active !== true) throw new Error("Task phase admission is no longer active");
      if (event.kind === "handoff") event = { ...event, pending_task_ids: admission.pending_task_ids };
    }
    const prepared = await taskNative({ operation: "prepare_event", event });
    if (prepared.ok === false) throw new Error("Task preparation unavailable; do not start native work");
    frame.prepared = prepared;
    Object.assign(frame.context, prepared);
    const task = prepared.execution || prepared.review?.[0] || prepared.completion
      || (prepared.planning?.length === 1 ? prepared.planning[0] : undefined);
    if (task) frame.traceFields!["agentteams.task.id"] = task;
    const team = prepared.context?.task?.team || prepared.context?.team;
    if (team) frame.traceFields!["agentteams.team.id"] = team;
  } else if (["manager", "leader", "team_leader"].includes(role)) {
    frame.context.sources = await taskNative({ operation: "sources", meta });
    if (role === "manager") frame.deliveryRoom = meta.room_id;
  }
  if (event?.kind === "assistant_digest") return frame;
  if (!event && role !== "manager") frame.journal = await prepareNativeMessage(meta);
  if (role === "manager") frame.roster = await taskNative({ operation: "roster", role });
  else if (["leader", "team_leader"].includes(role)) frame.roster = await taskNative({
    operation: "roster", role, team: meta.registered_team,
  });
  return frame;
}
