import contextlib
import io
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "start-openclaw-gateway.py"
LEASE_REFUSAL = (
    "[openclaw] Reason: Cannot read shared state for discovery: /state/openclaw.sqlite. "
    "Retry after the current state operation completes. GatewayLockNamespaceError: "
    "cannot verify Gateway ownership from this process (different PID namespace); "
    "the owner heartbeat is fresh — run this command inside the Gateway container "
    "or with a shared PID namespace. If the previous Gateway stopped, wait up to "
    "90 seconds after its last heartbeat. holder 7 at old/pid-ns 42, "
    "last renewed 6 s ago. wait 84 s and retry.\n"
)


class GatewayStartupTest(unittest.TestCase):
    def run_gateway(self, *attempts):
        with (
            patch.object(subprocess, "Popen") as start,
            patch("time.sleep") as sleep,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            children = []
            for code, lines in attempts:
                child = MagicMock()
                child.stdout = io.StringIO(lines)
                child.wait.return_value = code
                child.__enter__.return_value = child
                children.append(child)
            start.side_effect = children
            with self.assertRaises(SystemExit) as outcome:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            return outcome.exception.code, start.call_count, sleep.call_args_list

    def test_waits_for_old_namespace_once(self):
        status, starts, waits = self.run_gateway((1, LEASE_REFUSAL), (0, "[gateway] ready\n"))
        self.assertEqual((status, starts), (0, 2))
        self.assertEqual([wait.args for wait in waits], [(84,)])

    def test_returns_second_native_failure(self):
        status, starts, waits = self.run_gateway((1, LEASE_REFUSAL), (1, LEASE_REFUSAL))
        self.assertEqual((status, starts, len(waits)), (1, 2, 1))

    def test_does_not_retry_after_binding_or_on_unrelated_failures(self):
        for lines in ("[gateway] http server listening (19 plugins)\n" + LEASE_REFUSAL,
                      "Invalid config\n", LEASE_REFUSAL.replace("wait 84 s", "wait 99 s")):
            with self.subTest(lines=lines):
                self.assertEqual(self.run_gateway((1, lines)), (1, 1, []))
