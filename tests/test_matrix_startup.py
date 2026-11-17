"""Exercise the real launch preamble without starting a gateway or model."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MatrixStartupTest(unittest.TestCase):
    def test_launch_preserves_matrix_state_and_controller_token(self):
        source = (Path(__file__).resolve().parents[1] / 'scripts/worker-entrypoint.sh').read_text()
        preamble = source.split('log "Starting Worker Agent: ${WORKER_NAME}"', 1)[1].split(
            '# Materialize the selected Harness', 1)[0]
        for populated in (False, True):
            with self.subTest(populated=populated), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / 'openclaw.json'
                config.write_text(json.dumps({'channels': {'matrix': {
                    'homeserver': 'http://matrix.invalid', 'userId': '@worker:test',
                    'accessToken': 'controller-token'}}}))
                before_config = config.read_bytes()
                state = root / '.openclaw/matrix/accounts/default/server__worker/token/state'
                expected = {'openclaw.sqlite': b'persisted sync cursor',
                            'openclaw.sqlite-wal': b'uncheckpointed native WAL',
                            'crypto.snapshot': b'persisted device identity'}
                if populated:
                    state.mkdir(parents=True)
                    for name, data in expected.items():
                        (state / name).write_bytes(data)
                calls = root / 'network-calls'
                script = '''
set -eu
log() { :; }
mc() { echo mc >> "$CALLS"; echo synthetic-password; }
curl() { echo curl >> "$CALLS"; echo '{"access_token":"new-token","device_id":"new-device"}'; }
''' + preamble
                subprocess.run(['bash', '-c', script], env={**os.environ, 'HOME': directory,
                    'WORKSPACE': directory, 'WORKER_CONFIG': str(config), 'WORKER_NAME': 'worker',
                    'AGENTTEAMS_STORAGE_PREFIX': 'test/storage', 'CALLS': str(calls)},
                    check=True, capture_output=True, timeout=10)
                self.assertFalse(calls.exists(), 'startup must not fetch a password or create a new device')
                self.assertEqual(config.read_bytes(), before_config)
                if populated:
                    self.assertEqual({p.name: p.read_bytes() for p in state.iterdir()}, expected)
                else:
                    self.assertFalse((root / '.openclaw/matrix').exists())


if __name__ == '__main__':
    unittest.main()
