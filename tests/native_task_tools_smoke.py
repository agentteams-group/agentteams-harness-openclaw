"""Discover bundled Task tools with the image's real native MCP client."""
import json
import subprocess

result = subprocess.run(
    ["mcporter", "list", "--stdio", "python3", "--stdio-arg",
     "/opt/agentteams/plugins/teamharness/mcp/server.py", "--json"],
    check=True, capture_output=True, text=True, timeout=45,
)
catalog = json.loads(result.stdout)
assert catalog["status"] == "ok", catalog["status"]
taskflow = next(tool for tool in catalog["tools"] if tool["name"] == "taskflow")
actions = taskflow["inputSchema"]["properties"]["action"]["enum"]
assert {"ack_task", "checkpoint_task", "submit_task"}.issubset(actions), actions
print("Native mcporter discovered ack/checkpoint/submit Task tools (no model or Task E2E)")
