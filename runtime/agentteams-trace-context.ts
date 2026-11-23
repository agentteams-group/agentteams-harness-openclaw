// Correlation only: Task authority remains in the shared recovery client.
type Fields = Record<string, string | number | boolean | string[]>;
const slot = Symbol.for("agentteams.openclaw.trace-context");
const state = globalThis as typeof globalThis & { [slot]?: Map<string, Fields> };
const contexts = state[slot] ??= new Map<string, Fields>();

export function registerTaskTraceContext(sessionKey: string, fields: Fields, mergeInputs = false) {
  if (mergeInputs) {
    const previous = contexts.get(sessionKey)?.["agentteams.input.event_ids"];
    const current = fields["agentteams.input.event_ids"];
    fields = { ...fields, "agentteams.input.event_ids": [...new Set([
      ...(Array.isArray(previous) ? previous : []), ...(Array.isArray(current) ? current : []),
    ])] };
  }
  contexts.set(sessionKey, fields);
  // Keep late native diagnostics correlated without retaining an unbounded history.
  while (contexts.size > 256) contexts.delete(contexts.keys().next().value!);
}

export function agentTeamsTraceAttrs(event: { sessionKey?: string; sessionId?: string; runId?: string; type?: string }): Fields {
  const worker = process.env.AGENTTEAMS_WORKER_NAME;
  if (!worker || process.env.AGENTTEAMS_OTEL_ENABLED !== "true") return {};
  const task = contexts.get(event.runId ?? "") ?? contexts.get(event.sessionKey ?? "") ?? {};
  if (event.runId && event.sessionKey) registerTaskTraceContext(event.runId, task);
  const fields: Fields = { "agentteams.worker.name": worker, "agentteams.runtime": "openclaw",
    "agentteams.telemetry.schema": "1", "agentteams.team.id": process.env.AGENTTEAMS_TEAM_NAME ?? "", ...task };
  if (event.sessionId) fields["agentteams.session.id"] = event.sessionId;
  if (event.runId) fields["agentteams.turn.id"] = event.runId;
  if (event.sessionKey) fields["agentteams.runtime.session_id"] = event.sessionKey;
  const attributes: Fields = { ...fields, "langfuse.user.id": worker };
  if (event.runId) attributes["langfuse.trace.name"] = `${worker} / turn`;
  if (event.type?.startsWith("model.call.")) attributes["langfuse.observation.type"] = "generation";
  else if (event.type?.startsWith("tool.execution.")) attributes["langfuse.observation.type"] = "tool";
  else if (event.type?.startsWith("run.")) attributes["langfuse.observation.type"] = "agent";
  attributes["langfuse.trace.tags"] = ["agentteams", "openclaw", ...(event.runId ? ["worker-turn"] : []),
    ...["task", "team", "room", "project"].filter((label) => fields[`agentteams.${label}.id`])
      .map((label) => `${label}:${fields[`agentteams.${label}.id`]}`)];
  if (event.sessionId) attributes["langfuse.session.id"] = event.sessionId;
  for (const [key, value] of Object.entries(fields)) {
    attributes[`langfuse.trace.metadata.${key}`] = value;
    attributes[`langfuse.observation.metadata.${key}`] = value;
  }
  return attributes;
}
