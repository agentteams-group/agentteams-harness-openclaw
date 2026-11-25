import type { AgentEvent } from "../../packages/agent-core/src/types.js";
import { redactSensitiveText } from "../logging/redact.js";

/** Native events become display-only run blocks; no message is fed back to the agent. */
export class MatrixTaskProgress {
  private static pending = new Map<string, MatrixTaskProgress>();
  readonly runId: string;
  private queue = Promise.resolve();
  private calls = new Map<string, { eventId: string; block: Record<string, unknown> }>();
  private unsubscribe?: () => void;
  constructor(private send: (content: Record<string, unknown>) => Promise<string>, runId: string) {
    this.runId = runId;
    MatrixTaskProgress.pending.set(runId, this);
  }

  static get(runId?: string) { return runId ? this.pending.get(runId) : undefined; }
  release() { if (MatrixTaskProgress.pending.get(this.runId) === this) MatrixTaskProgress.pending.delete(this.runId); }

  private bounded(value: unknown): unknown {
    const text = redactSensitiveText(JSON.stringify(value ?? null));
    return text.length <= 4096 ? JSON.parse(text) : { preview: text.slice(0, 4096), truncated: true };
  }

  attach(agent: { subscribe: (listener: (event: AgentEvent) => void) => () => void }) {
    this.release();
    this.unsubscribe?.();
    this.unsubscribe = agent.subscribe((event) => {
      this.queue = this.queue.then(() => this.publish(event)).catch((error) => {
        console.error("Matrix native progress delivery failed:", error.message);
      });
      if (event.type === "agent_end") this.unsubscribe?.();
    });
  }

  async flush() { await this.queue; }

  private async block(block: Record<string, unknown>, previous?: string) {
    const content = { msgtype: "m.notice", body: String(block.tool_name || "执行过程"),
      "org.agentteams.progress_only": true, "m.mentions": { user_ids: [] },
      "org.agentteams.run": { version: "1", run_id: this.runId, blocks: [block] } };
    return this.send(previous ? { ...content, "m.new_content": content,
      "m.relates_to": { rel_type: "m.replace", event_id: previous } } : content);
  }

  private async publish(event: AgentEvent) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const summary = event.message.content.filter((part) => part.type === "thinking")
        .map((part) => part.thinking).join("\n\n");
      if (summary) await this.block({ type: "thinking", content: redactSensitiveText(summary).slice(0, 4096) });
    } else if (event.type === "tool_execution_start" && !event.hideFromChannelProgress) {
      const block = { type: "tool_call", tool_call_id: event.toolCallId, tool_name: event.toolName,
        arguments: this.bounded(event.args ?? {}), status: "running", started_at: Date.now() };
      const eventId = await this.block(block);
      this.calls.set(event.toolCallId, { eventId, block });
    } else if (event.type === "tool_execution_end" && !event.hideFromChannelProgress) {
      const call = this.calls.get(event.toolCallId);
      if (call) await this.block({ ...call.block, result: this.bounded(event.result),
        status: event.isError ? "failed" : "succeeded", finished_at: Date.now() }, call.eventId);
    } else if (event.type === "agent_end") {
      const last = event.messages.findLast((message) => message.role === "assistant");
      const kind = last?.role === "assistant" && last.stopReason === "error" ? "failed"
        : last?.role === "assistant" && last.stopReason === "aborted" ? "cancelled" : "quiet";
      await this.block({ type: "error", kind, title: kind === "quiet" ? "已处理" : "执行未完成" });
    }
  }
}
