// Actual native exporter/OTLP boundary, with synthetic diagnostic events.
// This is not model, Controller, Langfuse or Task E2E acceptance.
import { afterEach, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext, emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { startLocalOtlpReceiver } from "/opt/openclaw/test/e2e/qa-lab/runtime/otel-test-support.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";
import { registerTaskTraceContext } from "/opt/openclaw/extensions/matrix/src/matrix/monitor/agentteams-trace-context.js";

afterEach(async () => {
  await stopStartedOtelServices();
  resetDiagnosticEventsForTest();
  vi.unstubAllEnvs();
});

it("exports scoped Task metadata and ingestion authentication without raw content", async () => {
  vi.stubEnv("AGENTTEAMS_WORKER_NAME", "fixture-worker");
  vi.stubEnv("AGENTTEAMS_TEAM_NAME", "fixture-team");
  vi.stubEnv("AGENTTEAMS_OTEL_ENABLED", "true");
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer%20fixture-ingest");
  vi.stubEnv("OTEL_BSP_SCHEDULE_DELAY", "1000");
  const receiver = startLocalOtlpReceiver(["private-model-content"], ["authorization"]);
  const port = await receiver.listen();
  try {
    await startOtelService({ endpoint: `http://127.0.0.1:${port}`, traces: true,
      metrics: false, logs: false, captureContent: false });
    const sessionKey = "agent:main:agentteams-task:fixture:new";
    registerTaskTraceContext(sessionKey, { "agentteams.task.id": "task-fixture",
      "agentteams.team.id": "fixture-team", "agentteams.execution.generation": 2,
      "agentteams.room.id": "!fixture:test", "agentteams.event.id": "$first" });
    const trace = createDiagnosticTraceContext();
    const run = { runId: "fixture-run", sessionKey, sessionId: "native-fixture",
      agentId: "main", provider: "test", model: "fixture-model", channel: "matrix", trace };
    emitTrustedDiagnosticEventWithPrivateData({ type: "run.started", ...run }, {});
    registerTaskTraceContext(run.runId, { "agentteams.task.id": "task-fixture",
      "agentteams.execution.generation": 2, "agentteams.room.id": "!fixture:test",
      "agentteams.event.id": "$first", "agentteams.input.event_ids": ["$first", "$second"],
      "agentteams.coordination.id": "c".repeat(32), "agentteams.coordination.kind": "task_submitted" }, true);
    emitTrustedDiagnosticEventWithPrivateData({ type: "model.call.started", ...run, callId: "model-call" }, {});
    emitTrustedDiagnosticEventWithPrivateData({ type: "model.call.completed", ...run, callId: "model-call",
      durationMs: 5 }, { modelContent: { inputMessages: [{ role: "user", content: "private-model-content" }] } });
    emitTrustedDiagnosticEventWithPrivateData({ type: "run.completed", ...run,
      durationMs: 5, outcome: "completed" }, {});
    await waitForDiagnosticEventsDrained();
    await stopStartedOtelServices();
    await expect.poll(() => receiver.capturedSpans.length, { timeout: 10000 }).toBeGreaterThan(0);
    const span = receiver.capturedSpans.find((s) => s.attributes["agentteams.task.id"] === "task-fixture");
    expect(span?.attributes["langfuse.user.id"]).toBe("fixture-worker");
    expect(span?.attributes["langfuse.session.id"]).toBe("native-fixture");
    expect(span?.attributes["langfuse.trace.metadata.agentteams.execution.generation"]).toBe(2);
    const model = receiver.capturedSpans.find((s) => s.attributes["langfuse.observation.type"] === "generation");
    expect(model?.attributes["agentteams.input.event_ids"]).toEqual(["$first", "$second"]);
    expect(model?.attributes["agentteams.turn.id"]).toBe(run.runId);
    expect(model?.attributes["agentteams.runtime.session_id"]).toBe(sessionKey);
    expect(model?.attributes["agentteams.coordination.id"]).toBe("c".repeat(32));
    expect(model?.attributes["langfuse.trace.tags"]).toContain("room:!fixture:test");
    expect(receiver.capturedRequests[0].headerValues?.authorization).toBe("Bearer fixture-ingest");
    expect(JSON.stringify(receiver.capturedSpans)).not.toContain("fixture-ingest");
    expect(JSON.stringify(receiver.capturedSpans)).not.toContain("private-model-content");
    expect(receiver.capturedRequests.every((r) => r.signal === "traces")).toBe(true);
  } finally { await receiver.close(); }
});
