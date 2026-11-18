"""Standard Worker startup configuration; these do not run a Task or Matrix."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(os.environ['AT_SOURCE']) / 'shared/lib'))
spec = importlib.util.spec_from_file_location('configure_runtime', ROOT / 'scripts/configure-runtime.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class NativeValidationTest(unittest.TestCase):
    def test_validation_does_not_open_the_running_worker_state(self):
        with tempfile.TemporaryDirectory() as temp:
            live = Path(temp) / '.openclaw'
            live.mkdir()
            config_file = Path(temp) / 'candidate.json'
            config_file.write_text('{}')
            with patch.dict(os.environ, {'OPENCLAW_STATE_DIR': str(live)}):
                def validate(command, *, env, **kwargs):
                    self.assertEqual(command, ['openclaw', 'config', 'validate', '--json'])
                    self.assertEqual(env['OPENCLAW_CONFIG_PATH'], str(config_file))
                    isolated = Path(env['OPENCLAW_STATE_DIR'])
                    self.assertNotEqual(isolated, live)
                    self.assertTrue(isolated.is_dir())
                    (isolated / 'state.sqlite').write_bytes(b'validation')
                    return config.subprocess.CompletedProcess(command, 0, '{"valid":true}', '')

                with patch.object(config.subprocess, 'run', side_effect=validate) as native:
                    config.validate_native(config_file)
                self.assertEqual(os.environ['OPENCLAW_STATE_DIR'], str(live))
                self.assertFalse(Path(native.call_args.kwargs['env']['OPENCLAW_STATE_DIR']).exists())
                self.assertEqual(list(live.iterdir()), [])

    def test_process_exit_and_unreadable_report_are_diagnosed_without_output(self):
        for returncode, expected in ((-9, "signal 9"), (1, "exit status 1"), (0, "no valid report")):
            with self.subTest(returncode=returncode):
                result = config.subprocess.CompletedProcess([], returncode, 'private config output', 'private diagnostics')
                with patch.object(config.subprocess, 'run', return_value=result):
                    with self.assertRaisesRegex(ValueError, expected) as error:
                        config.validate_native(Path('/tmp/native.json'))
                self.assertNotIn('private', str(error.exception))


class RuntimeConfigTest(unittest.TestCase):
    def setUp(self):
        validator = patch.object(config, 'validate_native')
        self.addCleanup(validator.stop)
        validator.start()

    def record(self):
        return {'apiVersion': 'agentteams.io/v1beta1', 'kind': 'MemberRuntimeConfig',
                'member': {'runtime': 'openclaw', 'runtimeName': 'worker', 'role': 'worker',
                           'matrixUserId': '@worker:test', 'personalRoomId': '!home:test'},
                'storage': {'memberPrefix': 'agents/worker'},
                'matrix': {'transport': {'homeserver': 'http://matrix.test', 'encryption': True,
                                        'groupPolicy': 'allowlist', 'groupAllowFrom': ['@leader:test'],
                                        'requireMention': True, 'freeResponseRooms': ['!team:test'],
                                        'dm': {'policy': 'allowlist', 'allowFrom': ['@human:test']}}},
                'desired': {'model': {'model': 'worker-model', 'gatewayUrl': 'http://gateway.test', 'input': ['text']}},
                'credentials': {'matrixTokenEnv': 'BOUND_MATRIX_TOKEN', 'gatewayKeyEnv': 'BOUND_MODEL_KEY'}}

    def test_native_input_rebuilt_without_compatibility_or_session_directory(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'new-matrix-token', 'BOUND_MODEL_KEY': 'new-model-key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(self.record()))
            target = config.configure(root)
            native = json.loads(target.read_text())
            self.assertEqual(target, root / 'runtime/compat-config.json')
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertFalse((root / '.openclaw').exists())
            self.assertFalse((root / 'openclaw.json').exists())
            self.assertEqual(native['agents']['defaults']['workspace'], str(root))
            self.assertEqual(native['agents']['defaults']['model']['primary'], 'agentteams-gateway/worker-model')
            self.assertEqual(native['gateway']['auth']['token'], 'new-model-key')
            matrix = native['channels']['matrix']
            self.assertEqual(matrix['accessToken'], 'new-matrix-token')
            self.assertEqual(matrix['groupAllowFrom'], ['@leader:test'])
            self.assertEqual(matrix['dm']['allowFrom'], ['@human:test'])
            self.assertFalse(matrix['groups']['!home:test']['requireMention'])
            self.assertFalse(matrix['groups']['!team:test']['requireMention'])
            self.assertTrue(matrix['groups']['*']['requireMention'])
            self.assertNotIn('homeRoomId', matrix)
            self.assertNotIn('freeResponseRooms', matrix)
            self.assertTrue(matrix['network']['dangerouslyAllowPrivateNetwork'])

    def test_standard_model_never_reads_stale_compatibility_data(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'new-token', 'BOUND_MODEL_KEY': 'new-key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            path = root / 'runtime/runtime.yaml'
            path.write_text(yaml.safe_dump(self.record()))
            (root / 'openclaw.json').write_text('invalid old native/compatibility configuration')
            target = config.configure(root)
            current = target.read_bytes()
            os.environ.pop('BOUND_MODEL_KEY')
            with self.assertRaisesRegex(ValueError, 'binding'):
                config.configure(root)
            self.assertEqual(target.read_bytes(), current)

    def test_newer_standard_model_replaces_the_same_native_cache(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'new-token', 'BOUND_MODEL_KEY': 'new-key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            record = self.record()
            path = root / 'runtime/runtime.yaml'
            path.write_text(yaml.safe_dump(record))
            target = config.configure(root)
            record['desired']['model']['model'] = 'newer-model'
            path.write_text(yaml.safe_dump(record))
            self.assertEqual(config.configure(root), target)
            self.assertEqual(json.loads(target.read_text())['agents']['defaults']['model']['primary'], 'agentteams-gateway/newer-model')

    def test_older_controller_keeps_external_compatibility_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(config.configure(root), root / 'openclaw.json')

    def test_live_updates_preserve_device_token_only_for_unchanged_binding(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'bootstrap-token',
                'BOUND_MODEL_KEY': 'new-key', 'NEW_MATRIX_BINDING': 'rotated-token'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            record = self.record()
            (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(record))
            target = config.configure(root)
            native = json.loads(target.read_text())
            native['channels']['matrix']['accessToken'] = 'current-device-token'
            target.write_text(json.dumps(native))
            pending = root / 'runtime/pending.yaml'
            record['desired']['model']['model'] = 'updated-model'
            pending.write_text(yaml.safe_dump(record))
            config.configure(root, pending)
            self.assertEqual(json.loads(target.read_text())['channels']['matrix']['accessToken'], 'current-device-token')
            record['credentials']['matrixTokenEnv'] = 'NEW_MATRIX_BINDING'
            pending.write_text(yaml.safe_dump(record))
            config.configure(root, pending)
            self.assertEqual(json.loads(target.read_text())['channels']['matrix']['accessToken'], 'rotated-token')

    def test_resolved_heartbeat_is_not_replaced_with_a_native_default(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'new-token', 'BOUND_MODEL_KEY': 'new-key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            record = self.record()
            for enabled, every, expected in [(True, '7m', '7m'), (False, '7m', '0m')]:
                record['desired']['heartbeat'] = {'enabled': enabled, 'every': every}
                (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(record))
                native = json.loads(config.configure(root).read_text())
                self.assertEqual(native['agents']['defaults']['heartbeat']['every'], expected)

    def test_native_validation_failure_does_not_replace_live_cache(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'token', 'BOUND_MODEL_KEY': 'key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(self.record()))
            target = config.configure(root)
            previous = target.read_bytes()
            with patch.object(config, 'validate_native', side_effect=ValueError('native validator rejected')):
                with self.assertRaises(ValueError):
                    config.configure(root)
            self.assertEqual(target.read_bytes(), previous)
            self.assertEqual(list((root / 'credentials').iterdir()), [])

    def test_declared_subagent_model_is_registered_and_selected(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'token', 'BOUND_MODEL_KEY': 'key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            record = self.record()
            record['desired']['subagentModel'] = {'providerId': 'agentteams-gateway', 'model': 'agentteams-gateway/helper-model'}
            (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(record))
            native = json.loads(config.configure(root).read_text())
            self.assertEqual(native['agents']['defaults']['subagents']['model'], 'agentteams-gateway/helper-model')
            self.assertIn('helper-model', [model['id'] for model in native['models']['providers']['agentteams-gateway']['models']])

    def test_standard_observability_enables_native_export_and_disabled_record_removes_it(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'AGENTTEAMS_WORKER_NAME': 'worker', 'BOUND_MATRIX_TOKEN': 'token', 'BOUND_MODEL_KEY': 'key'}):
            root = Path(temp)
            (root / 'runtime').mkdir()
            record = self.record()
            for enabled in [True, False]:
                record['desired']['observability'] = {'revision': 'controller-revision', 'enabled': enabled,
                    'captureContent': False, 'collectorEndpoint': 'http://collector:4318' if enabled else ''}
                (root / 'runtime/runtime.yaml').write_text(yaml.safe_dump(record))
                native = json.loads(config.configure(root).read_text())
                self.assertEqual(native['diagnostics']['otel']['enabled'], enabled)
                if enabled:
                    self.assertIn('/opt/openclaw/extensions/diagnostics-otel', native['plugins']['load']['paths'])
                    self.assertTrue(native['plugins']['entries']['diagnostics-otel']['enabled'])
                    self.assertEqual(native['diagnostics']['otel']['endpoint'], 'http://collector:4318')
                    self.assertFalse(native['diagnostics']['otel']['captureContent'])
                else:
                    self.assertNotIn('diagnostics-otel', native['plugins']['entries'])
                    self.assertNotIn('endpoint', native['diagnostics']['otel'])


if __name__ == '__main__':
    unittest.main()
