"""Installed SDK schema/readback check; no gateway, Matrix, model or Task."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

import yaml


def main():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        runtime = root / 'runtime/runtime.yaml'
        runtime.parent.mkdir()
        record = {
            'apiVersion': 'agentteams.io/v1beta1', 'kind': 'MemberRuntimeConfig',
            'member': {'runtime': 'openclaw', 'runtimeName': 'worker', 'role': 'worker',
                       'matrixUserId': '@worker:test', 'personalRoomId': '!home:test'},
            'storage': {'memberPrefix': 'agents/worker'},
            'matrix': {'transport': {'homeserver': 'http://matrix.invalid', 'encryption': False,
                                    'groupPolicy': 'allowlist', 'groupAllowFrom': ['@leader:test'],
                                    'dm': {'policy': 'allowlist', 'allowFrom': ['@human:test']}}},
            'desired': {'model': {'model': 'worker-standard-model', 'gatewayUrl': 'http://gateway.invalid'},
                        'subagentModel': {'providerId': 'agentteams-gateway', 'model': 'helper-model'},
                        'heartbeat': {'enabled': False, 'every': '0m'}},
            'credentials': {'matrixTokenEnv': 'SMOKE_MATRIX_TOKEN', 'gatewayKeyEnv': 'SMOKE_MODEL_KEY'},
        }
        runtime.write_text(yaml.safe_dump(record))
        # An invalid old compatibility input must not block standard startup.
        (root / 'openclaw.json').write_text('invalid old compatibility input')
        env = {**os.environ, 'HOME': temp, 'AGENTTEAMS_WORKER_NAME': 'worker',
               'SMOKE_MATRIX_TOKEN': 'synthetic-matrix-token', 'SMOKE_MODEL_KEY': 'synthetic-model-key'}
        output = subprocess.check_output(['python3', '/opt/agentteams/scripts/configure-runtime.py', temp], env=env, text=True).strip()
        env['OPENCLAW_CONFIG_PATH'] = output
        validation = json.loads(subprocess.check_output(['openclaw', 'config', 'validate', '--json'], env=env, text=True))
        assert validation.get('valid') is True, 'native schema validation failed'
        for key, expected in [('agents.defaults.model.primary', 'agentteams-gateway/worker-standard-model'),
                              ('agents.defaults.subagents.model', 'agentteams-gateway/helper-model'),
                              ('agents.defaults.workspace', temp), ('agents.defaults.heartbeat.every', '0m')]:
            value = json.loads(subprocess.check_output(['openclaw', 'config', 'get', key, '--json'], env=env, text=True))
            assert value == expected, 'native readback mismatch for ' + key
        assert not (root / '.openclaw/agents').exists(), 'this check must not create native sessions'
        assert Path(output).stat().st_mode & 0o777 == 0o600
    print('PASS: standard Worker input -> OpenClaw native schema and config readback; no Matrix/model/Task execution')


if __name__ == '__main__':
    main()
