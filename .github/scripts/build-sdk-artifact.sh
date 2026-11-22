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
# Restore only public upstream patch targets, then validate the complete merged set.
python3 - <<'PYRESET'
import re, subprocess
from pathlib import Path
names = ['direct-control', 'task-coordination', 'task-recovery', 'observability', 'work-admission', 'task-protocol']
patches = [Path('/frozen/patches') / (name + '.patch') for name in names]
targets = {match for patch in patches for match in re.findall(r'^\+\+\+ b/(.+)$', patch.read_text(), re.M)}
for target in sorted(targets):
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + target]))
for patch in patches:
    subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
    subprocess.run(['git', 'apply', str(patch)], check=True)
print('All six merged Worker patches apply together to upstream SDK', flush=True)
PYRESET
python3 - <<'PYREUSE'
import json, shutil, tarfile
from pathlib import Path
roots=json.loads(Path('/reuse/output-roots.json').read_text())
for root in roots:
    assert not root.startswith('/') and '..' not in Path(root).parts
    shutil.rmtree(root, ignore_errors=True)
with tarfile.open('/reuse/openclaw-sdk-runtime.tar.gz', 'r:gz') as archive:
    for member in archive.getmembers():
        assert not member.name.startswith('/') and '..' not in Path(member.name).parts
        assert any(member.name == root or member.name.startswith(root + '/') for root in roots)
    archive.extractall('.', filter='data')
print('Reused complete immutable SDK output roots; no second SDK compilation', flush=True)
PYREUSE
cp /reuse/qa-runtime-plan.json /export/qa-runtime-plan.json
cp /reuse/openclaw-sdk-runtime.tar.gz.sha256 /export/reused-sdk-runtime.sha256
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
  compiledWorkerSource:process.env.SDK_COMPILED_REF,reusedArtifactId:14741471578,coreSource:process.env.CORE_REF,sdkBase:process.env.SDK_BASE,ciRevision:process.env.CI_REVISION,
  realTaskCertification:false}, null, 2) + '\n');
JS
cd /export
sha256sum /frozen/patches/*.patch /frozen/runtime/*.ts > worker-inputs.sha256

# Native SDK checks execute against the actual patched source and compiled SDK.
cd /opt/openclaw
git archive HEAD test | tar -x
for name in task-protocol task-checkpoint task-journal task-queue; do
  cp /frozen/tests/$name.test.ts src/agents/agentteams-$name.test.ts
done
for name in direct-control task-coordination; do
  cp /frozen/tests/$name.test.ts extensions/matrix/src/matrix/monitor/agentteams-$name.test.ts
done
cp /frozen/tests/observability.test.ts extensions/diagnostics-otel/src/agentteams-observability.test.ts
node_modules/.bin/vitest run --config /frozen/tests/direct-control.vitest.config.ts \
  extensions/matrix/src/matrix/monitor/agentteams-{direct-control,task-coordination}.test.ts \
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
