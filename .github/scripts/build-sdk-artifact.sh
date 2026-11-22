#!/bin/bash
set -euo pipefail
trap 'printf "\nFINAL_RESOURCE_COUNTERS\n"; /bin/sh /frozen/.github/scripts/cgroup-build-sample.sh' EXIT
/bin/sh /frozen/.github/scripts/cgroup-build-sample.sh
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
# Native SDK checks execute against the actual patched source and compiled SDK.
git archive HEAD test | tar -x
for name in task-protocol task-checkpoint task-journal task-queue; do
  cp /frozen/tests/$name.test.ts src/agents/agentteams-$name.test.ts
done
cp /frozen/tests/observability.test.ts extensions/diagnostics-otel/src/agentteams-observability.test.ts
node_modules/.bin/vitest run --config /frozen/tests/direct-control.vitest.config.ts \
  src/agents/agentteams-task-{protocol,checkpoint,journal,queue}.test.ts \
  extensions/diagnostics-otel/src/agentteams-observability.test.ts
python3 /frozen/tests/native_task_tools_smoke.py
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
const bundles = fs.readdirSync('dist', {recursive:true}).filter(p => typeof p === 'string' && p.endsWith('.js'));
for (const marker of ['Native SDK did not retain the verified Human input', 'Canonical Task outcome requires authoritative verification before model admission']) {
  assert(bundles.some(p => fs.readFileSync('dist/' + p, 'utf8').includes(marker)), marker);
}
fs.writeFileSync('/export/native-verdict.json', JSON.stringify({nativeSDKChecksPassed:true,compiledTaskHooksPresent:true,
  platform:process.platform,architecture:process.arch,node:process.version,workerSource:process.env.WORKER_REF,
  coreSource:process.env.CORE_REF,sdkBase:process.env.SDK_BASE,ciRevision:process.env.CI_REVISION,
  realTaskCertification:false}, null, 2) + '\n');
JS
tar -czf /export/openclaw-sdk-runtime.tar.gz -T /export/output-roots.txt
cd /export
sha256sum openclaw-sdk-runtime.tar.gz > openclaw-sdk-runtime.tar.gz.sha256
sha256sum /frozen/patches/task-protocol.patch /frozen/runtime/agentteams-task-*.ts > worker-inputs.sha256
