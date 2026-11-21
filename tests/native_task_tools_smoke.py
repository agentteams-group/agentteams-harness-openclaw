"""Discover bundled Task tools with the image's real native MCP client."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='agentteams-own-native-plugin-') as temporary:
    root = Path(temporary)
    config = root / 'openclaw.json'
    config.write_text(json.dumps({'plugins': {'allow': ['agentteams-teamharness'],
        'load': {'paths': ['/opt/agentteams/plugins/teamharness/adapters/openclaw']},
        'entries': {'agentteams-teamharness': {'enabled': True}}}}))
    env = {**os.environ, 'HOME': temporary, 'OPENCLAW_STATE_DIR': str(root / 'state'),
           'OPENCLAW_CONFIG_PATH': str(config), 'AGENTTEAMS_AGENT_ROLE': 'worker'}
    plugins = subprocess.run(['openclaw', 'plugins', 'list', '--json'], env=env,
                             check=True, capture_output=True, text=True, timeout=60)
    payload = json.loads(plugins.stdout)
    plugin = next(item for item in payload['plugins'] if item['id'] == 'agentteams-teamharness')
    assert plugin.get('status') == 'loaded', plugin.get('error', plugin.get('status'))

result = subprocess.run(
    ["mcporter", "list", "--stdio", "python3", "--stdio-arg",
     "/opt/agentteams/plugins/teamharness/mcp/server.py", "--json"],
    check=True, capture_output=True, text=True, timeout=45,
)
catalog = json.loads(result.stdout)
assert catalog["status"] == "ok", catalog["status"]
task = next(tool for tool in catalog["tools"] if tool["name"] == "task")
actions = task["inputSchema"]["properties"]["action"]["enum"]
assert {"begin", "submit", "files_read", "files_get"}.issubset(actions), actions
health = subprocess.run(
    ["mcporter", "call", "--stdio", "python3", "--stdio-arg",
     "/opt/agentteams/plugins/teamharness/mcp/server.py", "health", "--output", "json"],
    check=True, capture_output=True, text=True, timeout=45,
)
assert json.loads(health.stdout)["ok"] is True
print("Native SDK loaded the common Task plugin and MCP schema (no model or Task E2E)")
