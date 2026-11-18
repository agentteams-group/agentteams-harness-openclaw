import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(os.environ.get("AT_SOURCE", Path(__file__).resolve().parents[2])) / "shared/lib"))

from openclaw_worker_config import render


class OpenClawWorkerConfigTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.runtime = self.home / "runtime/runtime.yaml"
        self.runtime.parent.mkdir()
        self.record = {"apiVersion":"agentteams.io/v1beta1","kind":"MemberRuntimeConfig",
            "member":{"role":"worker","runtime":"openclaw","runtimeName":"alice","matrixUserId":"@alice:hs","personalRoomId":"!dm:hs"},
            "storage":{"memberPrefix":"agents/alice"}, "matrix":{"transport":{"homeserver":"https://matrix.example","groupPolicy":"allowlist",
                "groupAllowFrom":["@leader:hs"],"encryption":True,"dm":{"policy":"allowlist","allowFrom":["@owner:hs"]}}},
            "desired":{"model":{"model":"example","gatewayUrl":"https://model.example"},"heartbeat":{"enabled":False,"every":"0m"}}}
        self.runtime.write_text(yaml.safe_dump(self.record))
        self.enterContext(patch.dict(os.environ,{"AGENTTEAMS_CONTROLLER_URL":"http://fixture","AGENTTEAMS_WORKER_GATEWAY_KEY":"test-model",
            "AGENTTEAMS_WORKER_MATRIX_TOKEN":"test-matrix","AGENTTEAMS_AGENT_ROLE":"worker"}))

    def test_starts_from_worker_record_without_external_openclaw_json(self):
        path=render(self.home,"alice")
        config=json.loads(path.read_text())
        self.assertEqual(path.parent,self.home/"credentials")
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertFalse((self.home/"openclaw.json").exists())
        matrix=config["channels"]["matrix"]
        self.assertEqual(matrix["accessToken"],"test-matrix")
        self.assertTrue(matrix["encryption"])
        self.assertFalse(matrix["groups"]["!dm:hs"]["requireMention"])
        self.assertNotIn("homeRoomId",matrix)
        self.assertEqual(config["models"]["providers"]["agentteams-gateway"]["api"],"openai-completions")
        self.assertEqual(config["agents"]["defaults"]["heartbeat"]["every"],"0m")

    def test_native_options_preserved_while_record_overrides_stale_matrix_and_model(self):
        path=self.home/"openclaw.json"
        compatibility={"tools":{"profile":"coding"},"channels":{"matrix":{"homeserver":"https://old","groupAllowFrom":["*"],"deviceId":"OLD",
            "network":{"dangerouslyAllowPrivateNetwork":True}}},"models":{"providers":{"old":{}}}}
        path.write_text(json.dumps(compatibility))
        result=json.loads(render(self.home,"alice").read_text())
        self.assertEqual(result["tools"],compatibility["tools"])
        self.assertEqual(result["channels"]["matrix"]["groupAllowFrom"],["@leader:hs"])
        self.assertNotIn("deviceId",result["channels"]["matrix"])
        self.assertEqual(result["channels"]["matrix"]["network"],{"dangerouslyAllowPrivateNetwork":True})
        self.assertNotIn("old",result["models"]["providers"])
        self.assertEqual(json.loads(path.read_text()),compatibility)
        self.record["member"]["runtime"]="codex"
        self.runtime.write_text(yaml.safe_dump(self.record))
        with self.assertRaisesRegex(ValueError,"identity"):
            render(self.home,"alice")

    def test_encrypted_restart_delegates_device_selection_to_native_sdk(self):
        with patch.dict(os.environ, {"AGENTTEAMS_OPENCLAW_DEVICE_PASSWORD":"private-fixture"}):
            path = render(self.home,"alice")
        matrix = json.loads(path.read_text())["channels"]["matrix"]
        self.assertNotIn("accessToken",matrix)
        self.assertNotIn("deviceId",matrix)
        self.assertEqual(matrix["password"],"${AGENTTEAMS_OPENCLAW_DEVICE_PASSWORD}")
        self.assertNotIn("private-fixture",path.read_text())

    def test_legacy_and_manager_use_their_config(self):
        self.runtime.unlink()
        self.assertEqual(render(self.home,"alice"),self.home/"openclaw.json")
        self.runtime.write_text(yaml.safe_dump(self.record))
        with patch.dict(os.environ,{"AGENTTEAMS_AGENT_ROLE":"manager"}):
            self.assertEqual(render(self.home,"alice"),self.home/"openclaw.json")
