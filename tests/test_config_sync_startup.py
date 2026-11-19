"""Configuration synchronization must not rewrite a gateway still bootstrapping."""
import os
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import yaml


class ConfigSyncStartupTest(unittest.TestCase):
    def run_sync(self, ready):
        source = (Path(__file__).resolve().parents[1] / 'scripts/worker-entrypoint.sh').read_text()
        function = re.search(r'^start_config_sync\(\) \{.*?^\}', source, re.M | re.S).group()
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'events'
            script = r'''
set -eu
CONFIG_SYNC_INTERVAL=300
log() { :; }
ensure_mc_credentials() { :; }
openclaw() {
    echo health >> "$EVENT_LOG"
    printf '{"ok":%s}\n' "$READY"
}
mc() { echo fetch >> "$EVENT_LOG"; return 1; }
sleep() {
    # End the bulk-sync subprocess; it is unrelated to this startup check.
    if [ "$1" = 300 ]; then exit 0; fi
    count=$(cat "$COUNTER" 2>/dev/null || echo 0)
    count=$((count + 1))
    echo "$count" > "$COUNTER"
    if [ "$count" -gt 3 ]; then exit 0; fi
}
'''
            subprocess.run(['bash', '-c', script + '\n' + function + '\nstart_config_sync\nwait\n'],
                           env={**os.environ, 'EVENT_LOG': str(log), 'COUNTER': directory + '/count',
                                'READY': 'true' if ready else 'false', 'AGENTTEAMS_STORAGE_PREFIX': 'test',
                                'WORKSPACE': directory,
                                'WORKER_CONFIG': directory + '/openclaw.json',
                                'WORKER_NAME': 'test'}, check=True, capture_output=True, timeout=10)
            return log.read_text().splitlines() if log.exists() else []

    def test_unready_gateway_does_not_fetch_or_rewrite_config(self):
        self.assertNotIn('fetch', self.run_sync(False))

    def test_ready_gateway_resumes_config_updates(self):
        events = self.run_sync(True)
        self.assertIn('fetch', events)
        self.assertEqual(events[0], 'health')

    def test_standard_updates_ignore_compatibility_and_fence_invalid_bindings(self):
        root = Path(__file__).resolve().parents[1]
        function = re.search(r'^start_config_sync\(\) \{.*?^\}', (root / 'scripts/worker-entrypoint.sh').read_text(), re.M | re.S).group()
        for invalid in (False, True):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                (home / 'bin').mkdir()
                validator = home / 'bin/openclaw'
                validator.write_text('#!/bin/sh\nprintf \'{"valid":true}\\n\'\n')
                validator.chmod(0o755)
                (home / 'runtime').mkdir()
                record = {'apiVersion': 'agentteams.io/v1beta1', 'kind': 'MemberRuntimeConfig',
                          'member': {'runtime': 'openclaw', 'runtimeName': 'worker', 'matrixUserId': '@worker:test'},
                          'storage': {'memberPrefix': 'agents/worker'},
                          'matrix': {'transport': {'homeserver': 'http://matrix.test'}},
                          'desired': {'model': {'model': 'initial-model', 'gatewayUrl': 'http://gateway.test'}},
                          'credentials': {'matrixTokenEnv': 'BOUND_MATRIX_TOKEN', 'gatewayKeyEnv': 'BOUND_MODEL_KEY'}}
                live = home / 'runtime/runtime.yaml'
                live.write_text(yaml.safe_dump(record))
                env = {**os.environ, 'WORKSPACE': directory, 'WORKER_NAME': 'worker',
                       'PATH': str(home / 'bin') + os.pathsep + os.environ['PATH'],
                       'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'matrix-token', 'BOUND_MODEL_KEY': 'model-key',
                       'WORKER_CONFIG': str(home / 'runtime/compat-config.json'), 'COUNTER': str(home / 'count'),
                       'REMOTE_RECORD': str(home / 'remote.yaml'), 'EVENT_LOG': str(home / 'events'),
                       'AGENTTEAMS_STORAGE_PREFIX': 'agentteams/storage', 'CONFIGURE_SCRIPT': str(root / 'scripts/configure-runtime.py'),
                       'TEST_PYTHON': os.sys.executable, 'PULL_MARKER': str(home / '.last-pull'), 'WORKER_SYNC_STATE_DIR': str(home / 'sync')}
                subprocess.run([os.sys.executable, env['CONFIGURE_SCRIPT'], directory], env=env, check=True, capture_output=True)
                record['desired']['model']['model'] = 'current-model'
                if invalid:
                    record['credentials']['gatewayKeyEnv'] = 'MISSING_CURRENT_MODEL_BINDING'
                    env.pop('MISSING_CURRENT_MODEL_BINDING', None)
                Path(env['REMOTE_RECORD']).write_text(yaml.safe_dump(record))
                script = r'''
set -eu
CONFIG_SYNC_INTERVAL=300
log() { :; }
ensure_mc_credentials() { :; }
worker_sync_mark_remote_pull() { :; }
openclaw() { printf '{"ok":true}\n'; }
python3() { "$TEST_PYTHON" "$CONFIGURE_SCRIPT" "${@:2}"; }
mc() { echo "$2" >> "$EVENT_LOG"; cp "$REMOTE_RECORD" "$3"; }
sleep() {
  if [ "$1" = 300 ]; then exit 0; fi
  count=$(cat "$COUNTER" 2>/dev/null || echo 0)
  count=$((count + 1)); echo "$count" > "$COUNTER"
  if [ "$count" -gt 1 ]; then exit 0; fi
}
'''
                result = subprocess.run(['bash', '-c', script + '\n' + function + '\nstart_config_sync\nwait\n'],
                                        env=env, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, -15 if invalid else 0)
                native = json.loads(Path(env['WORKER_CONFIG']).read_text())
                expected = 'initial-model' if invalid else 'current-model'
                self.assertEqual(native['agents']['defaults']['model']['primary'], 'agentteams-gateway/' + expected)
                self.assertEqual((home / 'events').read_text().splitlines(), ['agentteams/storage/agents/worker/runtime/runtime.yaml'])


if __name__ == '__main__':
    unittest.main()
