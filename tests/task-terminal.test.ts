import { expect, it } from "vitest";
import { buildEmbeddedRunnerAssistant, makeEmbeddedRunnerAttempt } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveSettledTurnFinalizationRequest } from "./embedded-agent-runner/run/terminal-resolution.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";

function request(frame?: Record<string, unknown>) {
  const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
  const attempt = makeEmbeddedRunnerAttempt({ assistantTexts: ["NO_REPLY"], lastAssistant: assistant,
    currentAttemptAssistant: assistant, toolMetas: [{ toolName: "write", meta: "path=result.json", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true } });
  const params: any = { sessionId: "own", runId: "own", terminalReplyExpectation: "required",
    toolBindings: frame ? { agentteamsTask: frame } : undefined };
  const result = resolveSettledTurnFinalizationRequest({ runParams: params, attempt,
    activeErrorContext: { provider: "openai", model: "fixture" }, modelApi: "openai-responses",
    executionContract: undefined, payloadsWithToolMedia: [], hasTerminalToolPresentation: false,
    terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
    settledTurnFinalizationAvailable: true });
  return { result, params };
}

it("does not start settled-tool finalization after a confirmed silent Task phase", () => {
  const { result, params } = request({ finishedFact: "Saved immutable submission", finishedDisplay: "NO_REPLY" });
  expect(result).toBeNull();
  expect(params.terminalReplyExpectation).toBe("optional");
});

it.each([undefined, {}, { finishedDisplay: "NO_REPLY" },
  { finishedFact: "Saved", finishedDisplay: "Visible final report" },
  { finishedFact: "Saved", finishedDisplay: "NO_REPLY", unresolvedEffects: true }])(
  "retains the SDK reply requirement for an unfinished or unconfirmed phase %s", (frame) => {
    expect(request(frame).params.terminalReplyExpectation).toBe("required");
  });
