"""Start the Worker gateway and respect a previous PID namespace's lease."""
import re
import subprocess
import time


def main():
    for attempt in range(2):
        bound = False
        wait_seconds = 0
        with subprocess.Popen(
            ["openclaw", "gateway", "run", "--verbose", "--force"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        ) as gateway:
            for line in gateway.stdout:
                print(line, end="", flush=True)
                bound |= "[gateway] http server listening" in line
                if (
                    line.startswith("[openclaw] Reason: Cannot read shared state for discovery:")
                    and "GatewayLockNamespaceError:" in line
                    and "(different PID namespace); the owner heartbeat is fresh" in line
                ):
                    delay = re.search(r" wait ([0-9]{1,2}) s and retry\.$", line)
                    if delay:
                        wait_seconds = int(delay[1])
            status = gateway.wait()

        # Only retry admission. A running gateway's exit belongs to its supervisor.
        if status != 1 or attempt or bound or not 1 <= wait_seconds <= 90:
            return status if status >= 0 else 128 - status
        print(f"[agentteams] Waiting {wait_seconds}s for the previous OpenClaw lease", flush=True)
        time.sleep(wait_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
