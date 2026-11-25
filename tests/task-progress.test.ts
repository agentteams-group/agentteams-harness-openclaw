import { expect, it } from "vitest";
import { Agent } from "/opt/openclaw/packages/agent-core/src/agent.js";
import { createTurnSequenceStream, makeTool, model } from "/opt/openclaw/packages/agent-core/src/agent-loop.test-support.js";
import { MatrixTaskProgress } from "/opt/openclaw/src/agents/agentteams-task-progress.js";

it("projects real native reasoning/tool events and closes one display run without an extra model call", async () => {
  const sent: any[] = [], requests: any[] = [], executed: string[] = [];
  const display = new MatrixTaskProgress(async (content) => { sent.push(content); return "$" + sent.length; }, "openclaw:task:own:1");
  const agent = new Agent({ initialState: { model, tools: [makeTool("read", executed)] },
    streamFn: createTurnSequenceStream([
      [{ type: "thinking", thinking: "核对文件内容。" }, { type: "toolCall", id: "native-call", name: "read", arguments: {} }],
      [{ type: "text", text: "独立检查通过。" }],
    ], requests) });
  display.attach(agent);
  await agent.prompt("Verify the local fixture.");
  await display.flush();
  expect(requests).toHaveLength(2);
  expect(executed).toEqual(["read"]);
  const blocks = sent.map(row => (row["m.new_content"] ?? row)["org.agentteams.run"].blocks[0]);
  expect(blocks.map(block => block.type)).toEqual(["thinking", "tool_call", "tool_call", "error"]);
  expect(blocks[0].content).toBe("核对文件内容。");
  expect(blocks[1]).toMatchObject({ tool_call_id: "native-call", tool_name: "read", arguments: {}, status: "running" });
  expect(blocks[2]).toMatchObject({ tool_call_id: "native-call", status: "succeeded", result: { content: [{ type: "text", text: "read result" }] } });
  expect(sent[2]["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$2" });
  expect(blocks[3].kind).toBe("quiet");
  expect(sent.every(row => row["org.agentteams.progress_only"] && row["org.agentteams.run"].run_id === display.runId)).toBe(true);
  expect(JSON.stringify(agent.state.messages)).not.toContain("org.agentteams.run");
});
