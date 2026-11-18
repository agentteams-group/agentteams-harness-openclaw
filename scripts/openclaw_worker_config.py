"""Build the OpenClaw Gateway's private configuration from the Worker record."""
import argparse
import json
import os
from pathlib import Path
import tempfile

import yaml
from worker_runtime_config import project


def render(workspace, worker, compatibility=None):
    legacy = workspace / "openclaw.json"
    runtime = workspace / "runtime/runtime.yaml"
    if not os.getenv("AGENTTEAMS_CONTROLLER_URL") or os.getenv("AGENTTEAMS_AGENT_ROLE") == "manager" or not runtime.is_file():
        return legacy
    record = yaml.safe_load(runtime.read_text())
    if record.get("member", {}).get("role") == "manager" or not (record.get("matrix") or {}).get("transport"):
        return legacy
    compatibility = compatibility or legacy
    external = json.loads(compatibility.read_text()) if compatibility.is_file() else {}
    config = project(record, "openclaw", worker, external)
    matrix = config["channels"]["matrix"]
    previous = (external.get("channels") or {}).get("matrix") or {}
    # Preserve SDK-only settings such as proxy or crypto recovery options. The
    # common Worker record owns transport, room policy, account and credential.
    native = {**previous, **matrix}
    for key in ("homeRoomId", "freeResponseRooms", "requireMention", "autoThread", "dmMentionThreads", "deviceId"):
        native.pop(key, None)
    groups = dict(previous.get("groups") or {})
    groups["*"] = {**groups.get("*", {}), "requireMention": matrix.get("requireMention", True)}
    free = list(matrix.get("freeResponseRooms") or [])
    if matrix.get("homeRoomId"):
        free.append(matrix["homeRoomId"])
    for room in free:
        groups[room] = {**groups.get(room, {}), "requireMention": False}
    if native.get("encryption") and os.getenv("AGENTTEAMS_OPENCLAW_DEVICE_PASSWORD"):
        native.pop("accessToken", None)
        native["password"] = "${AGENTTEAMS_OPENCLAW_DEVICE_PASSWORD}"
    native.update(enabled=True, groups=groups)
    config["channels"]["matrix"] = native
    desired = record.get("desired") or {}
    defaults = config.setdefault("agents", {}).setdefault("defaults", {})
    defaults.setdefault("workspace", str(workspace))
    if desired.get("model"):
        gateway = config["models"]["providers"]["agentteams-gateway"]
        gateway["api"] = "openai-completions"
        for model in gateway["models"]:
            model.setdefault("name", model["id"])
        subagent = desired.get("subagentModel") or {}
        if subagent.get("model"):
            model_id = subagent["model"]
            if model_id not in [m["id"] for m in gateway["models"]]:
                gateway["models"].append({"id": model_id, "name": model_id, "input": subagent.get("input", ["text"])})
            defaults.setdefault("subagents", {})["model"] = "agentteams-gateway/" + model_id
        if "modelPolicy" in defaults:
            defaults["modelPolicy"]["allow"] = ["agentteams-gateway/" + m["id"] for m in gateway["models"]]
    heartbeat = desired.get("heartbeat")
    if heartbeat is not None:
        defaults.setdefault("heartbeat", {})["every"] = heartbeat.get("every", "30m") if heartbeat["enabled"] else "0m"
    config.setdefault("gateway", {}).setdefault("mode", "local")
    private = workspace / "credentials"
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = private / "openclaw-runtime.json"
    encoded = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    if target.is_file() and target.read_text() == encoded:
        return target
    with tempfile.NamedTemporaryFile(mode="w", dir=private, delete=False) as staged:
        try:
            staged.write(encoded)
            staged.close()
            os.replace(staged.name, target)
        finally:
            Path(staged.name).unlink(missing_ok=True)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", type=Path)
    parser.add_argument("--compatibility", type=Path)
    args = parser.parse_args()
    print(render(args.workspace, os.environ["AGENTTEAMS_WORKER_NAME"], args.compatibility))
