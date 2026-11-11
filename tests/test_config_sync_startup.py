"""Configuration synchronization must not rewrite a gateway still bootstrapping."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


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
                                'WORKER_NAME': 'test'}, check=True, capture_output=True, timeout=10)
            return log.read_text().splitlines() if log.exists() else []

    def test_unready_gateway_does_not_fetch_or_rewrite_config(self):
        self.assertNotIn('fetch', self.run_sync(False))

    def test_ready_gateway_resumes_config_updates(self):
        events = self.run_sync(True)
        self.assertIn('fetch', events)
        self.assertEqual(events[0], 'health')


if __name__ == '__main__':
    unittest.main()
