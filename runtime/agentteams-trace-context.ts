// Correlation only: Task authority remains in the shared recovery client.
type Fields = Record<string, string | number | boolean>;
const slot = Symbol.for("agentteams.openclaw.trace-context");
const state = globalThis as typeof globalThis & { [slot]?: Map<string, Fields> };
const contexts = state[slot] ??= new Map<string, Fields>();

export function registerTaskTraceContext(sessionKey: string, fields: Fields) {
  contexts.set(sessionKey, fields);
  // Keep late native diagnostics correlated without retaining an unbounded history.
  while (contexts.size > 256) contexts.delete(contexts.keys().next().value!);
}

export function agentTeamsTraceAttrs(event: { sessionKey?: string; sessionId?: string; runId?: string }): Fields {
  const worker = process.env.AGENTTEAMS_WORKER_NAME;
  if (!worker || process.env.AGENTTEAMS_OTEL_ENABLED !== "true") return {};
  const task = contexts.get(event.sessionKey ?? "") ?? contexts.get(event.runId ?? "") ?? {};
  if (event.runId && event.sessionKey) registerTaskTraceContext(event.runId, task);
  const fields: Fields = { "agentteams.worker.name": worker, "agentteams.runtime": "openclaw",
    "agentteams.team.id": process.env.AGENTTEAMS_TEAM_NAME ?? "", ...task };
  if (event.sessionId) fields["agentteams.session.id"] = event.sessionId;
  const attributes: Fields = { ...fields, "langfuse.user.id": worker };
  if (event.sessionId) attributes["langfuse.session.id"] = event.sessionId;
  for (const [key, value] of Object.entries(fields)) {
    attributes[`langfuse.trace.metadata.${key}`] = value;
    attributes[`langfuse.observation.metadata.${key}`] = value;
  }
  return attributes;
}
