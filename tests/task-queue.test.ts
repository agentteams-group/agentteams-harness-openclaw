// Actual SDK queue boundary; this checks identity retention, not model semantics.
import { expect, it } from "vitest";
import { createQueueTestRun } from "/opt/openclaw/src/auto-reply/reply/queue.test-helpers.js";
import { resolveFollowupDeliveryStorageKey } from "/opt/openclaw/src/auto-reply/reply/queue/delivery-context.js";
import { attachTaskProtocol } from "/opt/openclaw/src/agents/agentteams-task-protocol.js";

it("does not collect-batch distinct admitted sources under only the last source identity", () => {
  const bodies = ["Own first task request", "Cancel that first request", "Own separate second task"];
  const runs = bodies.map((body, index) => {
    const eventId = "$own-" + index;
    const inbound: any = { BodyForAgent: body };
    attachTaskProtocol(inbound, { context: { role: "manager", sourceEvent: eventId,
      sources: [{ eventId, inputId: "input-" + index, roomId: "!own:test", userId: "@human:test" }] } });
    const run = createQueueTestRun({ prompt: inbound.BodyForAgent });
    run.run.toolBindings = inbound.GatewayRunToolBindings;
    run.run.channelContext = inbound.ChannelContext;
    return run;
  });
  expect(new Set(runs.map(resolveFollowupDeliveryStorageKey)).size).toBe(3);
  for (const [index, run] of runs.entries()) {
    expect(run.prompt).toContain(bodies[index]);
    expect(run.run.toolBindings?.agentteamsTask.context.sourceEvent).toBe("$own-" + index);
  }
});
