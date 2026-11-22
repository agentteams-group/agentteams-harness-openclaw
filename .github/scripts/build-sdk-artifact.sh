#!/bin/bash
set -euo pipefail
trap 'printf "\nFINAL_RESOURCE_COUNTERS\n"; /bin/sh /frozen/.github/scripts/cgroup-build-sample.sh' EXIT
/bin/sh /frozen/.github/scripts/cgroup-build-sample.sh
# Match Dockerfile COPY ownership; host-checkout bind mounts have runner UID.
stat -c "%u:%g %a %n" /core-teamharness/adapters/openclaw
rm -rf /opt/agentteams/scripts/lib /opt/agentteams/plugins/teamharness
mkdir -p /opt/agentteams/scripts/lib /opt/agentteams/plugins/teamharness
cp -R /core-shared/. /opt/agentteams/scripts/lib/
cp -R /core-teamharness/. /opt/agentteams/plugins/teamharness/
stat -c "%u:%g %a %n" /opt/agentteams/plugins/teamharness/adapters/openclaw
cp /frozen/runtime/agentteams-task-recovery.ts /opt/openclaw/extensions/matrix/src/matrix/monitor/
cp /frozen/runtime/agentteams-trace-context.ts /opt/openclaw/extensions/matrix/src/matrix/monitor/
cp /frozen/runtime/agentteams-trace-context.ts /opt/openclaw/extensions/diagnostics-otel/src/
cp /frozen/runtime/agentteams-trace-context.ts /opt/openclaw/src/agents/
cp /frozen/runtime/agentteams-task-{protocol,checkpoint,journal}.ts /opt/openclaw/src/agents/
cp /frozen/scripts/*.py /frozen/scripts/*.sh /opt/agentteams/scripts/
cd /opt/openclaw
git apply --check /frozen/patches/task-protocol.patch
git apply /frozen/patches/task-protocol.patch
git show HEAD:tsdown.config.ts > tsdown.config.ts
node --import ./scripts/tsx.mjs /frozen/.github/scripts/qa-runtime-serial.mts --plan > /export/qa-runtime-plan.json
node --import ./scripts/tsx.mjs /frozen/.github/scripts/qa-runtime-serial.mts
rm tsdown.config.ts
# Export the complete output roots declared by the same upstream build owner.
node --import ./scripts/tsx.mjs --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { listTsdownOutputRoots } from './scripts/tsdown-build.mts';
const roots = listTsdownOutputRoots();
assert(roots.length > 2 && roots.includes('dist') && roots.includes('dist-runtime'));
for (const root of roots) {
  assert(!root.startsWith('/') && !root.split('/').includes('..') && fs.statSync(root).isDirectory(), root);
}
fs.writeFileSync('/export/output-roots.json', JSON.stringify(roots, null, 2) + '\n');
fs.writeFileSync('/export/output-roots.txt', roots.join('\n') + '\n');
fs.writeFileSync('/export/native-verdict.json', JSON.stringify({nativeSDKChecksPassed:false,compiledTaskHooksPresent:false,
  platform:process.platform,architecture:process.arch,node:process.version,workerSource:process.env.WORKER_REF,
  coreSource:process.env.CORE_REF,sdkBase:process.env.SDK_BASE,ciRevision:process.env.CI_REVISION,
  realTaskCertification:false}, null, 2) + '\n');
JS
tar -czf /export/openclaw-sdk-runtime.tar.gz -T /export/output-roots.txt
cd /export
sha256sum openclaw-sdk-runtime.tar.gz > openclaw-sdk-runtime.tar.gz.sha256
sha256sum /frozen/patches/task-protocol.patch /frozen/runtime/*.ts > worker-inputs.sha256

# Native SDK checks execute against the actual patched source and compiled SDK.
cd /opt/openclaw
git archive HEAD test | tar -x
for name in task-protocol task-checkpoint task-journal task-queue; do
  cp /frozen/tests/$name.test.ts src/agents/agentteams-$name.test.ts
done
cp /frozen/tests/observability.test.ts extensions/diagnostics-otel/src/agentteams-observability.test.ts
node_modules/.bin/vitest run --config /frozen/tests/direct-control.vitest.config.ts \
  src/agents/agentteams-task-{protocol,checkpoint,journal,queue}.test.ts \
  extensions/diagnostics-otel/src/agentteams-observability.test.ts
python3 /frozen/tests/native_task_tools_smoke.py
python3 - <<'PYTHON'
from pathlib import Path
import json
p = Path('/export/native-verdict.json')
result = json.loads(p.read_text())
result['nativeSDKChecksPassed'] = True
p.write_text(json.dumps(result, indent=2) + '\n')
PYTHON

# Package-based SDK versions emit the live agent runtime outside root dist/.
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const roots = JSON.parse(fs.readFileSync('/export/output-roots.json', 'utf8'));
const markers = ['Native SDK did not retain the verified Human input', 'Canonical Task outcome requires authoritative verification before model admission'];
const matches = Object.fromEntries(markers.map(marker => [marker, []]));
for (const root of roots) {
  for (const name of fs.readdirSync(root, {recursive:true})) {
    if (typeof name !== 'string' || !/\.(?:js|mjs|cjs)$/.test(name)) continue;
    const path = root + '/' + name;
    if (!fs.statSync(path).isFile()) continue;
    const body = fs.readFileSync(path, 'utf8');
    for (const marker of markers) if (body.includes(marker)) matches[marker].push(path);
  }
}
fs.writeFileSync('/export/compiled-task-hook-locations.json', JSON.stringify(matches, null, 2) + '\n');
for (const marker of markers) assert(matches[marker].length > 0, marker);
const result = JSON.parse(fs.readFileSync('/export/native-verdict.json', 'utf8'));
result.compiledTaskHooksPresent = true;
fs.writeFileSync('/export/native-verdict.json', JSON.stringify(result, null, 2) + '\n');
JS
