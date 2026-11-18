#!/bin/bash
set -euo pipefail

node -e 'const p = require("/opt/openclaw/package.json"); if (`v${p.version}` !== process.env.AGENTTEAMS_OPENCLAW_TAG) throw new Error(`OpenClaw pin mismatch: ${p.version}`)'
openclaw --version
agt --help >/dev/null
for helper in install-worker-skill.sh safe-extract-worker-skill.py push-worker-skills.sh; do
    test -r "/opt/agentteams/agent/skills/worker-management/scripts/${helper}"
done
mc.bin --version
mc --version
test -r /opt/agentteams/scripts/lib/task_recovery_rpc.py
test -r /opt/agentteams/plugins/teamharness/mcp/server.py
grep -rlF --include='*.js' 'Task recovery deferred; authority unavailable' /opt/openclaw/dist >/dev/null
bash -n /opt/agentteams/scripts/worker-entrypoint.sh
source /opt/agentteams/scripts/lib/agentteams-env.sh
source /opt/agentteams/scripts/lib/merge-openclaw-config.sh
source /opt/agentteams/scripts/lib/migrate-openclaw-config.sh
source /opt/agentteams/scripts/lib/worker-file-sync.sh
source /opt/agentteams/scripts/lib/worker-isolation.sh
config=$(mktemp)
trap 'rm -f "$config"' EXIT
printf '%s\n' '{"agents":{"defaults":{"workspace":"/tmp/smoke"}}}' > "$config"
migrate_openclaw_config "$config"
jq -e '.agents.defaults.workspace == "/tmp/smoke"' "$config" >/dev/null
