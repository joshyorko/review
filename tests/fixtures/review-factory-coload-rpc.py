#!/usr/bin/env python3
"""Credential-free krun RPC transport used only by the co-load smoke."""
import json
import pathlib
import queue
import subprocess
import sys
import threading
import time
import uuid


def main():
    image, home, factory, requests_jsonl = sys.argv[1:]
    marker = uuid.uuid4().hex
    name = f"review-coload-{marker}"
    label = "io.github.joshyorko.review.smoke"
    args = [
        "podman", "run", "--runtime=krun", "--rm", "--name", name,
        "--label", f"{label}={marker}", "--interactive", "--tty", "--network", "host",
        "--userns", "keep-id:uid=65532,gid=65532",
    ]
    env = {
        "HOME": "/home/review", "XDG_CONFIG_HOME": "/host-xdg",
        "XDG_STATE_HOME": "/home/review/.local/state", "XDG_CACHE_HOME": "/home/review/.cache",
        "REVIEW_DEFAULT_SCOPE": "example/repo",
        "GH_TOKEN": "", "GITHUB_TOKEN": "",
    }
    if factory == "enabled":
        env["LUNA_FACTORY_ENABLED"] = "1"
    for key, value in env.items():
        args += ["--env", f"{key}={value}"]
    args += [
        "--volume", f"{pathlib.Path(home).resolve()}:/home/review:rw", image,
        "--mode", "rpc-ui", "--no-skills", "--no-rules", "--no-pty",
        "--model", "local-probe/deterministic",
    ]
    process = subprocess.Popen(
        args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    events = queue.Queue()
    records = []
    deadline = time.monotonic() + 60

    def read_output():
        for line in process.stdout:
            print(line, end="", flush=True)
            try:
                event = json.loads(line)
            except ValueError:
                continue
            records.append(event)
            events.put(event)
        events.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()

    def wait_for(predicate):
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("RPC deadline exceeded")
            try:
                event = events.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("RPC deadline exceeded") from None
            if event is None:
                status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
                raise RuntimeError(f"appliance exited {status} before the expected RPC response")
            if predicate(event):
                return event

    try:
        wait_for(lambda event: event.get("type") == "available_commands_update")
        requests = [{"id": "commands", "type": "get_available_commands"}]
        requests += [json.loads(line) for line in requests_jsonl.splitlines() if line.strip()]
        for request in requests:
            process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            process.stdin.flush()
            response = wait_for(lambda event: event.get("id") == request["id"] and event.get("type") == "response")
            if response.get("success") is not True:
                raise RuntimeError(f"RPC request failed: {response}")
        # Closing a host pipe does not send EOF to krun's guest terminal.
        process.stdin.write("\x04")
        process.stdin.flush()
        process.stdin.close()
        status = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        reader.join(timeout=5)
        if reader.is_alive():
            raise RuntimeError("appliance output did not close after exit")
        print(f"review-factory-coload-rpc: appliance exit={status}", flush=True)
        if status != 0:
            return status if status > 0 else 128 - status
        if any(event.get("type") == "agent_start" or event.get("agentInvoked") is True for event in records):
            raise RuntimeError("command-only smoke unexpectedly invoked an agent")
        return 0
    finally:
        if process.poll() is None:
            # Refuse to clean anything except this invocation's labelled container.
            try:
                owned = subprocess.run(
                    ["podman", "container", "inspect", "--format", f'{{{{index .Config.Labels "{label}"}}}}', name],
                    capture_output=True, text=True, timeout=5,
                )
                if owned.returncode == 0 and owned.stdout.strip() == marker:
                    subprocess.run(["podman", "rm", "--force", "--time", "5", name], check=True, timeout=10)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                print(f"review-factory-coload-rpc: cleanup appliance exit={process.returncode}", flush=True)
        reader.join(timeout=5)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.SubprocessError) as error:
        print(f"review-factory-coload-rpc: {error}", file=sys.stderr)
        sys.exit(1)
