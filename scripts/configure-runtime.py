"""Derive OpenClaw configuration from the Controller-owned Worker record."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

import yaml

sys.path.insert(0, os.environ.get('AGENTTEAMS_LOG_LIB_DIR', '/opt/agentteams/scripts/lib'))
from worker_runtime_config import project


def validate_native(path):
    result = subprocess.run(['openclaw', 'config', 'validate', '--json'],
                            env={**os.environ, 'OPENCLAW_CONFIG_PATH': str(path)}, capture_output=True, text=True)
    try:
        valid = json.loads(result.stdout).get('valid') is True
    except (ValueError, AttributeError):
        valid = False
    if result.returncode != 0 or not valid:
        if result.returncode < 0:
            outcome = f'signal {-result.returncode}'
        elif result.returncode > 0:
            outcome = f'exit status {result.returncode}'
        else:
            outcome = 'no valid report'
        raise ValueError(f'Native OpenClaw configuration validation failed ({outcome}); refusing publication')


def configure(workspace: Path, record_path: Path | None = None) -> Path:
    runtime = record_path or workspace / 'runtime/runtime.yaml'
    compatibility = workspace / 'openclaw.json'
    if not runtime.is_file():
        return compatibility
    record = yaml.safe_load(runtime.read_text())
    # Older shared Manager projections do not yet publish transport. Keep
    # their external compatibility path; Worker records require the contract.
    if (os.getenv('AGENTTEAMS_AGENT_ROLE') == 'manager'
            and record.get('member', {}).get('role') == 'manager'
            and record.get('matrix', {}).get('transport') is None):
        return compatibility
    worker = os.environ['AGENTTEAMS_WORKER_NAME']
    legacy = None
    if record.get('desired', {}).get('model') is None and compatibility.is_file():
        legacy = json.loads(compatibility.read_text())
    native = project(record, 'openclaw', worker, legacy)
    matrix = native['channels']['matrix']
    target = workspace / 'runtime/compat-config.json'
    # A live config update may retain the device token acquired after boot.
    # Startup never reads this cache, and changed bindings/identity do not reuse it.
    previous = workspace / 'runtime/runtime.yaml'
    if record_path is not None and previous.is_file() and target.is_file():
        old = yaml.safe_load(previous.read_text())
        def binding(doc):
            member = doc.get('member', {})
            return (member.get('runtime'), member.get('runtimeName'), member.get('matrixUserId'),
                    doc.get('matrix', {}).get('transport', {}).get('homeserver'),
                    doc.get('credentials', {}).get('matrixTokenEnv', 'AGENTTEAMS_WORKER_MATRIX_TOKEN'),
                    doc.get('matrix', {}).get('accessToken'))
        if binding(old) == binding(record):
            current = json.loads(target.read_text()).get('channels', {}).get('matrix', {}).get('accessToken')
            if current:
                matrix['accessToken'] = current
    home_room = matrix.pop('homeRoomId', '')
    require_mention = matrix.pop('requireMention', True)
    free_response_rooms = matrix.pop('freeResponseRooms', None) or []
    matrix.pop('dmMentionThreads', None)
    history = matrix.pop('historyLimit', None)
    matrix.update(enabled=True, autoJoin='always',
                  network={'dangerouslyAllowPrivateNetwork': True},
                  groups={'*': {'requireMention': require_mention}})
    for room in [home_room, *free_response_rooms]:
        if room and room != '*':
            matrix['groups'][room] = {'requireMention': False}
    defaults = native.setdefault('agents', {}).setdefault('defaults', {})
    heartbeat = record.get('desired', {}).get('heartbeat') or {'enabled': False, 'every': '0m'}
    defaults.update(workspace=str(workspace), heartbeat={'every': heartbeat['every'] if heartbeat['enabled'] else '0m'})
    providers = native['models']['providers']
    if record.get('desired', {}).get('model') is not None:
        gateway = providers['agentteams-gateway']
        gateway['api'] = 'openai-completions'
        for model in gateway['models']:
            model['name'] = model['id']
        native['gateway'] = {'mode': 'local', 'port': 18799, 'bind': 'lan',
                             'auth': {'token': gateway['apiKey']}, 'remote': {'token': gateway['apiKey']}}
    subagent = record.get('desired', {}).get('subagentModel')
    if subagent and subagent.get('model'):
        provider = subagent.get('providerId', 'agentteams-gateway')
        model_id = subagent['model'].removeprefix(provider + '/')
        if provider not in providers:
            raise ValueError('Your standard subagent model provider is unavailable')
        models = providers[provider]['models']
        if not any(model['id'] == model_id for model in models):
            models.append({'id': model_id, 'name': model_id, 'input': subagent.get('input', ['text'])})
        defaults.setdefault('subagents', {})['model'] = provider + '/' + model_id
    native.setdefault('plugins', {}).setdefault('load', {})['paths'] = ['/opt/openclaw/extensions/matrix']
    native['plugins'].setdefault('entries', {})['matrix'] = {'enabled': True}
    tracing = record.get('desired', {}).get('observability')
    if tracing is not None:
        enabled = tracing['enabled'] is True
        native['diagnostics'] = {'enabled': enabled, 'otel': {'enabled': enabled}}
        if enabled:
            if not tracing.get('collectorEndpoint'):
                raise ValueError('Your standard tracing collector endpoint is unavailable')
            native['diagnostics']['otel'].update(endpoint=tracing['collectorEndpoint'], protocol='http/protobuf',
                traces=True, metrics=False, logs=False, captureContent=tracing.get('captureContent') is True,
                serviceName='agentteams-worker')
            native['plugins']['load']['paths'].append('/opt/openclaw/extensions/diagnostics-otel')
            native['plugins']['entries']['diagnostics-otel'] = {'enabled': True}
    group_chat = native.setdefault('messages', {}).setdefault('groupChat', {})
    group_chat['mentionPatterns'] = [r'(^|[^A-Za-z0-9_@-])@' + re.escape(worker) + r'($|[^A-Za-z0-9_-])']
    if history is not None:
        group_chat['historyLimit'] = history
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = workspace / 'credentials'
    staging.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=staging, prefix='.runtime-config-', delete=False) as pending:
        try:
            json.dump(native, pending)
            pending.close()
            validate_native(pending.name)
            if not target.is_file() or target.read_bytes() != Path(pending.name).read_bytes():
                os.replace(pending.name, target)
        finally:
            Path(pending.name).unlink(missing_ok=True)
    target.chmod(0o600)
    return target


if __name__ == '__main__':
    # Only the derived file path is printed; configuration secrets stay private.
    print(configure(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else None))
