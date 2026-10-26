#!/usr/bin/env python3
"""Tandem: live messages between an open Claude Code session and an open Codex thread.

Claude -> Codex: `send --from claude` queues the message into the Codex thread
with `codex queue` when a Codex app has the thread open, so it runs there live as
the next turn; otherwise Tandem runs the turn itself through a short-lived
`codex app-server`, which also starts the threads Tandem creates (they show in
the Codex app under their names).
Codex -> Claude: `send --from codex` writes to the room log. Claude listens with
`watch` (under Claude Code's Monitor tool) or `poll` (one pass that prints JSON,
for a plugin); both also report Codex's final answer to each message Claude sent.

Rooms live in <project>/.tandem/<room>/ and are git-ignored through
.git/info/exclude. Works with Python 3.9+ and only the standard library.
"""

import argparse
import contextlib
import fcntl
import glob
import json
import os
import queue
import re
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone

VERSION = "0.1.0"
HERE = os.path.dirname(os.path.realpath(__file__))
LAUNCHER = os.path.join(HERE, "tandem")
CODEX_HOME = os.path.expanduser(os.environ.get("CODEX_HOME", "~/.codex"))
BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
DEFAULT_LIMIT = 20
MAX_MESSAGE_CHARS = 32000
EVENT_MAX_CHARS = 6000
PENDING_WARN_SECONDS = 120
QUEUE_TIMEOUT_SECONDS = 120
TURN_TIMEOUT_SECONDS = 6 * 3600  # of awake time: a long high-effort turn, not a stuck one (Stop has its own path)
THREAD_WAIT_SECONDS = 600
APP_WAIT_SECONDS = 10  # for the Codex app to take a thread Tandem opened there
APP_OPENER = os.environ.get("TANDEM_OPENER", "/usr/bin/open")
ROOM_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
MARKER_TAIL = re.compile(r"\s*#tandem:[A-Za-z0-9._-]+:\d+\s*\Z")  # Tandem's marker, which agents sometimes echo
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
RESERVED_ROOMS = ("runs", "worktrees")  # Tandem's own folders in .tandem
WHO = {"claude": "Claude", "codex": "Codex", "user": "User", "tandem": "Tandem"}


def fail(message, code=2):
    print(f"tandem: {message}", file=sys.stderr)
    sys.exit(code)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dumps(value):
    # U+2028/U+2029 are line breaks to some readers; keep every record on one line for all of them.
    return json.dumps(value, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def read_json(path, default=None):
    try:
        with open(path) as f:
            value = json.load(f)
    except (OSError, ValueError):  # also a path through a plain file, such as .tandem/codex-limits.json/room.json
        return default
    return value


def write_json(path, data):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        f.write(dumps(data) + "\n")
    os.replace(tmp, path)


def parse_record(line):
    try:
        value = json.loads(line)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def file_size(path):
    try:
        return os.path.getsize(path)
    except (OSError, TypeError):
        return 0


def mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def read_new_lines(path, offset):
    """Complete lines written after `offset` (split on newline bytes only), and the offset after them."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
    except (FileNotFoundError, TypeError):
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    chunk = data[: end + 1]
    return [line.decode("utf-8", "replace") for line in chunk.split(b"\n")[:-1]], offset + len(chunk)


def file_contains(path, needle):
    needle = needle.encode()
    tail = b""
    try:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(4 << 20), b""):
                if needle in tail + block:
                    return True
                tail = block[-len(needle):]
    except (OSError, TypeError):
        pass
    return False


def project_root(cd):
    """The main checkout of the git repo holding `cd` (shared by its worktrees), else `cd` itself."""
    cd = os.path.abspath(os.path.expanduser(cd or os.getcwd()))
    if not os.path.isdir(cd):
        fail(f"not a directory: {cd}")
    try:
        common = subprocess.run(["git", "-C", cd, "rev-parse", "--git-common-dir"],
                                capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return cd, None
    common = os.path.abspath(os.path.join(cd, common))
    if os.path.basename(common) == ".git":
        return os.path.dirname(common), common
    return cd, common


def ensure_git_excluded(git_dir):
    if not git_dir:
        return
    path = os.path.join(git_dir, "info", "exclude")
    try:
        existing = open(path).read() if os.path.exists(path) else ""
        if "/.tandem/" not in existing.split():
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a") as f:
                f.write(("\n" if existing and not existing.endswith("\n") else "") + "/.tandem/\n")
    except OSError:
        pass


def find_rollout(thread_id):
    if not thread_id or not UUID_RE.fullmatch(thread_id):
        return None
    pattern = os.path.join(glob.escape(CODEX_HOME), "sessions", "**", f"rollout-*-{thread_id}.jsonl")
    matches = glob.glob(pattern, recursive=True)
    return max(matches, key=os.path.getmtime) if matches else None


def thread_names():
    names = {}
    try:
        with open(os.path.join(CODEX_HOME, "session_index.jsonl")) as f:
            for line in f:
                record = parse_record(line)
                if record and record.get("id") and record.get("thread_name"):
                    names[record["id"]] = record["thread_name"]
    except OSError:
        pass
    return names


def codex_binary():
    found = shutil.which("codex")
    if found:
        return found
    if os.access(BUNDLED_CODEX, os.X_OK):
        return BUNDLED_CODEX
    fail("codex CLI not found (install it with: npm install -g @openai/codex)", 3)


HOLDER_KINDS = ("Codex app", "Codex plugin in Claude Code", "Tandem turn", "Codex exec", "Codex CLI")
ONE_TURN_HOLDERS = ("Tandem turn", "Codex exec")  # runs that end with their turn and take nothing from the queue


def holder_kind(command):
    # Tandem's turns and `codex exec` may run the Codex CLI bundled in the app, so they are told apart first.
    if "TANDEM_TURN" in command:
        return "Tandem turn"
    if re.search(r"\sexec(\s|$)", command):
        return "Codex exec"
    if "ChatGPT.app" in command or "Codex.app" in command:
        return "Codex app"
    if "app-server-broker" in command or "codex-companion" in command:
        return "Codex plugin in Claude Code"
    return "Codex CLI"


def thread_holder(thread_id):
    """The program that has the thread open for writing (a Codex app or CLI), if any."""
    lock = os.path.join(CODEX_HOME, "thread-writer-locks", f"{thread_id}.lock")
    if not os.path.exists(lock):
        return None
    try:
        # lsof lives in /usr/sbin, which a minimal PATH (the Codex desktop app's) can leave out.
        lsof = shutil.which("lsof") or "/usr/sbin/lsof"
        pids = [pid for pid in subprocess.run([lsof, "-t", lock], capture_output=True, text=True, timeout=5).stdout.split()
                if pid != str(os.getpid())]
        if not pids:
            return None
        ps = shutil.which("ps") or "/bin/ps"
        commands = subprocess.run([ps, "-o", "command=", "-p", ",".join(pids)], capture_output=True, text=True,
                                  timeout=5).stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        return None
    # A holder that is exiting shows as <defunct>; it takes nothing from the queue.
    kinds = {holder_kind(command) for command in commands if command.strip() and "<defunct>" not in command}
    # Several processes can have the lock open; the one that takes queued messages wins.
    return next((kind for kind in HOLDER_KINDS if kind in kinds), None)


class Room:
    def __init__(self, args):
        if not ROOM_RE.fullmatch(args.room or "") or args.room in RESERVED_ROOMS:
            fail("room names start with a letter or digit and use letters, digits, '.', '_' and '-' (at most 64), "
                 f"and are not {' or '.join(RESERVED_ROOMS)}")
        self.name = args.room
        self.root, self.git_dir = project_root(args.cd)
        self.dir = os.path.join(self.root, ".tandem", self.name)
        self.meta_path = os.path.join(self.dir, "room.json")
        self.log_path = os.path.join(self.dir, "messages.jsonl")
        self.state_path = os.path.join(self.dir, "watch-state.json")
        self.seq_path = os.path.join(self.dir, "seq")
        self.lock_path = os.path.join(self.dir, "listener.lock")
        self.turns_dir = os.path.join(self.dir, "turns")
        self.turn_lock_path = os.path.join(self.dir, "turn.lock")

    def turn_running(self):
        """Whether a background Codex turn started by Tandem is running for this room."""
        os.makedirs(self.dir, exist_ok=True)
        with open(self.turn_lock_path, "a") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(f, fcntl.LOCK_UN)
            return False

    def meta(self):
        meta = read_json(self.meta_path)
        if not isinstance(meta, dict):
            fail(f'no room "{self.name}" in {self.root}; create it with: tandem open --room {self.name}')
        return meta

    def messages(self):
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, "rb") as f:
            return [record for record in (parse_record(line.decode("utf-8", "replace")) for line in f.read().split(b"\n")) if record]

    def next_number(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(self.seq_path, "a+") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            text = f.read().strip()
            last = int(text) if text.isdigit() else max([m.get("n", 0) for m in self.messages() if isinstance(m.get("n"), int)] or [0])
            f.seek(0)
            f.truncate()
            f.write(str(last + 1))
            return last + 1

    def append(self, message):
        os.makedirs(self.dir, exist_ok=True)
        with open(self.log_path, "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(dumps(message) + "\n")

    def state(self):
        state = read_json(self.state_path)
        if not isinstance(state, dict):
            state = {"log_offset": 0}
        for key, default in (("log_offset", 0), ("turn", None), ("markers", []), ("pending", {}), ("warned", []),
                             ("reviews", [])):
            state.setdefault(key, default)
        return state

    def bind(self, thread, from_start=False):
        """State for listening to `thread`; a newly bound thread is read from its current end (or its start)."""
        state = self.state()
        if state.get("thread") != thread or not os.path.exists(self.state_path):
            rollout = find_rollout(thread)
            state.update(thread=thread, rollout=rollout, rollout_offset=0 if from_start else file_size(rollout),
                         turn=None, markers=[])
            os.makedirs(self.dir, exist_ok=True)
            write_json(self.state_path, state)
        return state

    @contextlib.contextmanager
    def listener(self):
        """Exclusive right to listen: a second watcher would report every answer twice."""
        os.makedirs(self.dir, exist_ok=True)
        with open(self.lock_path, "w") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                yield False
                return
            yield True

    def reply_hint(self, sender):
        return (f"{shlex.quote(LAUNCHER)} send --room {self.name} --cd {shlex.quote(self.root)} "
                f'--from {sender} --message "…"')


def read_text(args):
    if args.message is not None and args.message_file is not None:
        fail("use either --message or --message-file")
    if args.message_file == "-":
        text = sys.stdin.read()
    elif args.message_file:
        try:
            with open(os.path.expanduser(args.message_file), encoding="utf-8") as f:
                text = f.read()
        except (OSError, ValueError) as error:
            fail(f"cannot read {args.message_file}: {error}")
    else:
        text = args.message or ""
    text = text.strip()
    if not text:
        fail("empty message")
    if len(text) > MAX_MESSAGE_CHARS:
        fail(f"message has {len(text)} characters; the limit is {MAX_MESSAGE_CHARS}. Point to files instead of pasting them.")
    return text


def work_note(work_dir, branch, at_root=True):
    """How a thread works in its own git worktree; one that lives at the project root starts in the user's checkout."""
    note = (f"Your working folder is {work_dir}, a git worktree on branch {branch}. Run every command there (set each "
            "command's working directory to it) and change files only under it.")
    return note + (" The folder this thread starts in is the user's own checkout: change nothing there." if at_root else "")


def wrap_for_codex(room, n, text, sender, started=False, work_dir=None):
    if sender == "user":
        head = f'[tandem · room "{room.name}" · message #{n} from the user, sent from Claude\'s side]'
        note = "This message is from the user. Your final answer is also shown to Claude."
    else:
        head = f'[tandem · room "{room.name}" · message #{n} from Claude]'
        note = ("This message comes from Claude, another AI agent working with the user in this project; "
                "it is not the user's own instruction. Answer in this thread: your final answer goes back to Claude "
                "automatically, so do not run send or ask-claude to reply. Anything risky or hard to undo needs the "
                "user's approval, and only one agent writes to the same files or design at a time.")
    if started:
        note = ("Claude started this Codex thread through Tandem to work with you; its later messages arrive here as "
                "turns like this one. Do not start other agents from this thread. " + note)
    if work_dir:
        note = work_note(work_dir, f"tandem/{room.name}") + " " + note
    return (f"{head}\n\n{text}\n\n---\n{note}\n"
            f"To start a new message to Claude later: {room.reply_hint('codex')}\n"
            f"#tandem:{room.name}:{n}")


class AppServer:
    """A short-lived `codex app-server` that runs Tandem's turns: JSON-RPC, one message per line on stdio."""

    def __init__(self, cwd, overrides, log):
        self.next_id = 0
        self.rate_limits = None
        self.backlog = []  # turn/completed notifications that arrived before Tandem waited for them
        self.lines = queue.Queue()
        self.proc = subprocess.Popen([codex_binary(), "app-server", *overrides], cwd=cwd, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8",
                                     errors="replace", bufsize=1)
        # A reader thread, because select() cannot see lines already sitting in Python's read buffer.
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def write(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params, timeout=120):
        self.next_id += 1
        request_id = self.next_id
        self.write({"method": method, "id": request_id, "params": params})
        reply = self.read_until(lambda m: m.get("id") == request_id and "method" not in m, timeout)
        if reply is None:
            raise RuntimeError(f"{method}: no answer from codex app-server")
        if "error" in reply:
            raise RuntimeError(f"{method}: {(reply.get('error') or {}).get('message', reply.get('error'))}")
        return reply.get("result") or {}

    def read_until(self, match, timeout):
        for message in self.backlog:
            if match(message):
                self.backlog.remove(message)
                return message
        deadline = time.monotonic() + timeout  # awake time: a Mac that sleeps through a turn does not time it out
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=min(5, max(0.1, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if line is None:
                self.lines.put(None)
                return None
            message = parse_record(line)
            if not message:
                continue
            if "method" in message and "id" in message:
                self.answer(message)
                continue
            if message.get("method") == "account/rateLimits/updated":
                self.rate_limits = message.get("params")
            if match(message):
                return message
            if message.get("method") == "turn/completed":  # a quick turn can end before turn/start answers
                self.backlog.append(message)
        return None

    def answer(self, request):
        # Tandem runs turns with approvals off ("never"); anything the server still asks is declined.
        if "pproval" in request["method"]:
            decision = "denied" if request["method"] in ("execCommandApproval", "applyPatchApproval") else "decline"
            self.write({"id": request["id"], "result": {"decision": decision}})
        else:
            self.write({"id": request["id"], "error": {"code": -32601, "message": "Tandem does not answer this request"}})

    def close(self):
        with contextlib.suppress(OSError):
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def nested(flat):
    """Dotted config keys (`features.multi_agent`) as the nested table a thread's `config` takes."""
    table = {}
    for key, value in flat.items():
        node = table
        *parents, last = key.split(".")
        for part in parents:
            node = node.setdefault(part, {})
        node[last] = value
    return table


def app_server_turn(room, spec, log, start_turn=True):
    """Run one Codex turn (in a new thread, or the next turn of one) through an app server; 0 once it completed.
    With start_turn False it only creates the thread (named, on its branch) and records it in spec["thread"]."""
    overrides = ["-c", 'shell_environment_policy.set.TANDEM_TURN="1"']  # marks this process as a one-turn run
    if spec.get("spawned"):
        overrides += ["-c", 'shell_environment_policy.set.TANDEM_SPAWNED="1"']
    for key, value in (spec.get("config") or {}).items():
        overrides += ["-c", f"{key}={json.dumps(value)}"]
    cwd = spec.get("cwd") or room.root
    # A thread lives in `cwd`: the Codex app lists a project's threads by the folder in Codex's state database, and
    # a turn that sets its own folder moves the thread there. So a worker's thread stays at the project root, and the
    # message names the git worktree it works in (`work_dir`, also where this server and the setup command run).
    work_dir = spec.get("work_dir") or cwd
    try:
        server = AppServer(work_dir, overrides, log)
    except OSError as error:
        log.write(f"tandem: could not start codex app-server: {error}\n")
        return 1
    except SystemExit:
        log.write("tandem: codex CLI not found on this PATH (install it with: npm install -g @openai/codex)\n")
        return 3
    try:
        server.request("initialize", {"clientInfo": {"name": "tandem", "title": "Tandem", "version": VERSION}})
        server.write({"method": "initialized"})
        settings = {key: spec[key] for key in ("model", "sandbox") if spec.get(key)}
        thread = spec.get("thread")
        if thread:
            server.request("thread/resume", {"threadId": thread, "approvalPolicy": "never", **settings})
        else:
            # The thread keeps its own settings too, for turns the Codex app runs in it.
            config = nested(dict(spec.get("config") or {}, **({"model_reasoning_effort": spec["effort"]} if spec.get("effort") else {})))
            thread = server.request("thread/start", {"cwd": cwd, "approvalPolicy": "never", **settings,
                                                     **({"config": config} if config else {})})["thread"]["id"]
            spec["thread"] = thread
            log.write(dumps({"type": "thread.started", "thread_id": thread}) + "\n")
            log.flush()
            if spec.get("name"):
                try:
                    server.request("thread/name/set", {"threadId": thread, "name": spec["name"]})
                except RuntimeError as error:
                    log.write(f"tandem: could not name the thread: {error}\n")
            if spec.get("branch"):  # the Codex app shows the thread's branch: the worktree's, not the checkout's
                try:
                    server.request("thread/metadata/update", {"threadId": thread, "gitInfo": {"branch": spec["branch"]}})
                except RuntimeError as error:
                    log.write(f"tandem: could not set the thread's branch: {error}\n")
            if not start_turn:
                return 0
        params = {"threadId": thread, "input": [{"type": "text", "text": spec["wrapped"]}]}
        if spec.get("effort"):
            params["effort"] = spec["effort"]
        if spec.get("output_schema"):
            params["outputSchema"] = spec["output_schema"]
        turn = server.request("turn/start", params)["turn"]["id"]
        done = server.read_until(lambda m: m.get("method") == "turn/completed"
                                 and ((m.get("params") or {}).get("turn") or {}).get("id") == turn, TURN_TIMEOUT_SECONDS)
        if done is None:
            log.write("tandem: the Codex turn did not finish\n")
            return 124
        result = done["params"]["turn"]
        if result.get("status") == "completed":
            return 0
        log.write(f"tandem: Codex turn {result.get('status')}: {(result.get('error') or {}).get('message', '')}\n")
        return 1
    except (RuntimeError, OSError, KeyError, TypeError) as error:
        log.write(f"tandem: {error}\n")
        return 1
    finally:
        if server.rate_limits:
            with contextlib.suppress(OSError):
                write_json(os.path.join(room.root, ".tandem", "codex-limits.json"), dict(server.rate_limits, at=now()))
        server.close()


def needs_own_settings(spec):
    """Whether a turn depends on Tandem's settings: a read-only or worktree sandbox, or an output schema. A Codex app
    or CLI that has the thread open runs a queued turn with its own settings for the thread (model, reasoning effort,
    sandbox, approvals) and without TANDEM_SPAWNED, so such a turn is never queued there."""
    return spec.get("sandbox") not in (None, "danger-full-access") or bool(spec.get("output_schema"))


def app_runs(spec):
    """Whether to hand the turn to the Codex app (see needs_own_settings)."""
    return bool(spec.get("in_app") and sys.platform == "darwin" and not os.environ.get("TANDEM_NO_APP")
                and not needs_own_settings(spec))


def held_elsewhere(holder, spec):
    """Why a turn that needs Tandem's settings cannot run while `holder` has its thread open."""
    own = f"the {spec['sandbox']} sandbox" if spec.get("sandbox") not in (None, "danger-full-access") else "the answer's schema"
    return (f"the {holder} has this thread open and would run the turn with its own settings instead of {own} Tandem "
            "gives it; close the thread there (the Codex app lets go of a thread when it restarts), then send again")


def turn_in_app(room, spec, log):
    """Hand the turn to the Codex desktop app: Tandem opens the thread there (in the background, without raising the
    app) and queues the message, so the thread shows at once and the user can watch and write in it. Without the app
    taking the thread, the turn runs here as usual."""
    if not spec.get("thread") and app_server_turn(room, spec, log, start_turn=False) != 0:
        return 1
    thread = spec["thread"]
    with contextlib.suppress(OSError, subprocess.TimeoutExpired):
        subprocess.run([APP_OPENER, "-g", f"codex://threads/{thread}"], capture_output=True, timeout=15,
                       stdin=subprocess.DEVNULL)
    deadline = time.time() + APP_WAIT_SECONDS
    while time.time() < deadline:
        if thread_holder(thread) == "Codex app":
            try:
                queue_for_codex(thread, spec["wrapped"])
            except SystemExit:  # the app has the thread, so a turn here could not write to it either
                log.write("tandem: codex queue could not hand the turn to the Codex app\n")
                return 5
            log.write("tandem: the turn runs in the Codex app\n")
            return 0
        time.sleep(0.5)
    log.write("tandem: the Codex app did not take the thread, so the turn runs in the background\n")
    return app_server_turn(room, spec, log)


def start_codex_turn(room, n, spec):
    """Run one Codex turn in the background (one at a time per room); returns the runner process.

    spec: wrapped (the message), thread (None starts a new one, named `name`), cwd, work_dir, model, effort, sandbox,
    config (extra Codex config), spawned, setup (a command to run in cwd first).
    """
    os.makedirs(room.turns_dir, exist_ok=True)
    write_json(os.path.join(room.turns_dir, f"{n}.json"), spec)
    runner = subprocess.Popen(
        [sys.executable, os.path.realpath(__file__), "run-turn", "--room", room.name, "--cd", room.root, "--n", str(n)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    with open(os.path.join(room.turns_dir, f"{n}.pid"), "w") as f:  # for the runners of later messages
        f.write(str(runner.pid))
    return runner


def runner_alive(pid):
    """Whether `pid` is a turn's runner that has not ended (an ended one may linger as a zombie of a long-lived parent)."""
    if not pid:
        return False
    ps = shutil.which("ps") or "/bin/ps"
    try:
        shown = subprocess.run([ps, "-o", "stat=,command=", "-p", str(pid)], capture_output=True, text=True,
                               timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "run-turn" in shown and not shown.startswith("Z")


def earlier_turn_running(room, n):
    """Whether the runner of an earlier message of this room is still alive and not done: turn n waits for it, since
    runners waiting on the room's lock are not woken in the order they came."""
    for name in os.listdir(room.turns_dir):
        number = name[:-4]
        if name.endswith(".pid") and number.isdigit() and int(number) < n \
                and not os.path.exists(os.path.join(room.turns_dir, f"{number}.exit")):
            try:
                with open(os.path.join(room.turns_dir, name)) as f:
                    pid = int(f.read().strip())
            except (OSError, ValueError):
                continue
            if pid != os.getpid() and runner_alive(pid):
                return True
    return False


def cmd_run_turn(args):
    room = Room(args)
    spec = read_json(os.path.join(room.turns_dir, f"{args.n}.json")) or {}
    exit_path = os.path.join(room.turns_dir, f"{args.n}.exit")
    result = {"code": 1}  # what an unexpected error leaves, so the turn never looks like it still runs
    try:
        with open(room.turn_lock_path, "a") as lock:
            deadline = time.time() + THREAD_WAIT_SECONDS
            while True:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if not earlier_turn_running(room, args.n) or time.time() > deadline:
                    break
                fcntl.flock(lock, fcntl.LOCK_UN)
                time.sleep(0.2)
            # Another one-turn run may still have the thread (say, the Codex turn that started this conversation):
            # wait for it. If a Codex app opens the thread meanwhile, hand the message to its queue instead.
            thread = spec.get("thread")
            deadline = time.time() + THREAD_WAIT_SECONDS
            holder = thread_holder(thread) if thread else None
            while holder in ONE_TURN_HOLDERS and time.time() < deadline:
                time.sleep(2)
                holder = thread_holder(thread)
            if holder and holder not in ONE_TURN_HOLDERS and needs_own_settings(spec):
                with open(os.path.join(room.turns_dir, f"{args.n}.log"), "w") as log:
                    log.write(f"tandem: {held_elsewhere(holder, spec)}\n")
                result = {"code": 6, "queued": False}
                return
            if holder and holder not in ONE_TURN_HOLDERS:
                try:
                    queue_for_codex(thread, spec["wrapped"])
                    result = {"code": 0, "queued": True}
                except SystemExit:
                    result = {"code": 5, "queued": False}
                return
            with open(os.path.join(room.turns_dir, f"{args.n}.log"), "w") as log:
                if holder:
                    log.write(f"tandem: the thread stayed busy for {THREAD_WAIT_SECONDS}s\n")
                    code = 75
                elif spec.get("setup") and not run_setup(spec, log):
                    code = 2
                elif app_runs(spec):
                    code = turn_in_app(room, spec, log)
                else:
                    code = app_server_turn(room, spec, log)
            result = {"code": code}
    finally:
        write_json(exit_path, result)


def run_setup(spec, log):
    """The project's setup command (for example `npm ci`), run in the new worktree before its first turn."""
    log.write(f"tandem: setup: {spec['setup']}\n")
    log.flush()
    try:
        done = subprocess.run(spec["setup"], shell=True, cwd=spec.get("work_dir") or spec.get("cwd"), stdout=log, stderr=subprocess.STDOUT,
                              stdin=subprocess.DEVNULL, timeout=1800)
    except (OSError, subprocess.TimeoutExpired) as error:
        log.write(f"tandem: setup failed: {error}\n")
        return False
    if done.returncode != 0:
        log.write(f"tandem: setup failed with status {done.returncode}\n")
    return done.returncode == 0


def turn_failure(room, n):
    """The tail of a failed background turn's output, or None while it runs or after it succeeded."""
    result = read_json(os.path.join(room.turns_dir, f"{n}.exit"))
    if not isinstance(result, dict) or result.get("code") == 0:
        return None
    try:
        with open(os.path.join(room.turns_dir, f"{n}.log")) as f:
            lines = [line for line in f.read().splitlines() if line.strip() and "rmcp::" not in line]
    except OSError:
        lines = []
    own = [line for line in lines if line.startswith("tandem:")]
    return "\n".join((own or lines)[-5:]) or f"codex exited with status {result.get('code')}"


def turn_settings(meta):
    """How Tandem runs turns of a thread it started: the settings stored in the room."""
    return {key: meta[key] for key in ("cwd", "work_dir", "model", "effort", "sandbox", "config", "spawned", "in_app")
            if meta.get(key)}


def deliver_to_codex(room, meta, n, wrapped):
    """Queue into a thread a Codex app has open, so it runs there live; otherwise run the turn in the background."""
    thread = meta["codex_thread"]
    holder = None if room.turn_running() else thread_holder(thread)
    if holder and holder not in ONE_TURN_HOLDERS:
        if needs_own_settings(meta):
            fail(held_elsewhere(holder, meta), 5)
        queue_id, status = queue_for_codex(thread, wrapped)
        return {"codex_queue_id": queue_id, "queue_status": status}
    spec = dict(turn_settings(meta), thread=thread, wrapped=wrapped)
    return {"queue_status": "background", "runner_pid": start_codex_turn(room, n, spec).pid}


def queue_for_codex(thread, wrapped):
    """Queue `wrapped` into the Codex thread; returns (queue id or None, status)."""
    try:
        result = subprocess.run([codex_binary(), "queue", "--thread", thread, "--message", wrapped],
                                capture_output=True, text=True, timeout=QUEUE_TIMEOUT_SECONDS,
                                stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "unknown"
    except OSError as error:
        fail(f"codex queue failed: {error}", 5)
    if result.returncode != 0:
        noise = ("rmcp::transport", "oauth::refresh")
        lines = [line for line in (result.stderr + result.stdout).splitlines()
                 if line.strip() and not any(word in line for word in noise)]
        fail(f"codex queue failed (exit {result.returncode}): " + "\n".join(lines[-8:]), 5)
    found = re.search(r"Queued message (\S+)", result.stdout)
    return (found.group(1).rstrip(".") if found else None), "queued"


def agent_messages_since_user(messages):
    count = 0
    for message in reversed(messages):
        if message.get("from") == "user":
            break
        if message.get("kind") == "message":
            count += 1
    return count


def open_room(room, thread=None, limit=None, from_start=False):
    """Create or update the room, bound to `thread` when given; returns its metadata."""
    meta = read_json(room.meta_path)
    if not isinstance(meta, dict):
        meta = {"room": room.name, "created_at": now(), "codex_thread": None, "limit": DEFAULT_LIMIT, "closed": False}
    if thread:
        if not UUID_RE.fullmatch(thread):
            fail(f"not a Codex thread id: {thread}")
        if meta.get("codex_thread") not in (None, thread):
            fail(f'room "{room.name}" belongs to another Codex thread ({meta["codex_thread"]}); use another room name')
        if not find_rollout(thread):
            fail(f"no Codex thread {thread} under {CODEX_HOME}/sessions")
        meta["codex_thread"] = thread
    if limit is not None:
        if limit < 1:
            fail("--limit must be at least 1")
        meta["limit"] = limit
    meta["closed"] = False
    os.makedirs(room.dir, exist_ok=True)
    ensure_git_excluded(room.git_dir)
    write_json(room.meta_path, meta)
    room.bind(meta["codex_thread"], from_start)
    return meta


def room_summary(room, meta):
    return {"room": room.name, "root": room.root, "thread": meta["codex_thread"],
            "thread_name": thread_names().get(meta["codex_thread"]) if meta["codex_thread"] else None,
            "limit": meta["limit"], "used": agent_messages_since_user(room.messages())}


def joinable_room(root, thread):
    """The most recently active open room of the project bound to `thread`, if any. A run's worker rooms are not:
    the run alone reads their answers."""
    base = os.path.join(root, ".tandem")
    found = []
    for name in os.listdir(base) if os.path.isdir(base) else []:
        meta = read_json(os.path.join(base, name, "room.json"))
        if (ROOM_RE.fullmatch(name) and isinstance(meta, dict) and meta.get("codex_thread") == thread
                and not meta.get("closed") and not meta.get("run")):
            found.append((max(mtime(os.path.join(base, name, f)) for f in ("room.json", "messages.jsonl")), name))
    return max(found)[1] if found else None


def cmd_open(args):
    thread = args.codex_thread or os.environ.get("CODEX_THREAD_ID")
    root = project_root(args.cd)[0]
    if args.join and thread:
        args.room = joinable_room(root, thread) or args.room
    room = Room(args)
    if thread and thread in room_threads(root, "run") and not (read_json(room.meta_path) or {}).get("run"):
        fail("this Codex thread is a worker of an orchestrated run: the run reads its answers. Message it through the "
             "run (orch send), or write to it in the Codex app.")
    meta = open_room(room, thread, args.limit)
    summary = room_summary(room, meta)
    if args.json:
        print(dumps(summary))
        return
    print(f'room "{room.name}": {room.dir}')
    print(f"codex thread: {meta['codex_thread'] or 'not set yet'}"
          + (f' ("{summary["thread_name"]}")' if summary["thread_name"] else ""))
    print(f"limit: {meta['limit']} agent messages until the user steps in")


def cmd_send(args):
    room = Room(args)
    message = send_message(room, room.meta(), args.sender, read_text(args))
    n = message["n"]
    if args.sender == "codex":
        print(f"#{n} sent; a Claude session listening to room {room.name} receives it.")
    elif message["queue_status"] == "background":
        print(f"#{n} is running in Codex thread {message['thread']} in the background (no Codex app has it open); "
              "the answer arrives through watch or poll.")
    elif message["queue_status"] == "unknown":
        print(f"#{n}: codex queue did not answer in {QUEUE_TIMEOUT_SECONDS}s; the message may still arrive.", file=sys.stderr)
        sys.exit(5)
    else:
        print(f"#{n} queued for Codex thread {message['thread']}; it runs as the next turn there, "
              "and the answer arrives through watch or poll.")


def send_message(room, meta, sender, text):
    """Log `text` from `sender`; a message from Claude or the user is also queued into the Codex thread."""
    if meta.get("closed"):
        fail(f'room "{room.name}" is closed; reopen it with: tandem open --room {room.name}')
    own = os.environ.get("CODEX_THREAD_ID")
    if sender == "codex" and not meta.get("codex_thread") and own and UUID_RE.fullmatch(own):
        meta["codex_thread"] = own
        write_json(room.meta_path, meta)
        room.bind(own)
    if sender in ("claude", "user") and not meta.get("codex_thread"):
        fail(f"room has no Codex thread yet; run: tandem open --room {room.name} --codex-thread ID")
    limit = meta.get("limit", DEFAULT_LIMIT)
    if sender != "user" and agent_messages_since_user(room.messages()) >= limit:
        fail(f"limit of {limit} agent messages reached; ask the user whether to continue "
             f"(they can raise it with: tandem open --room {room.name} --limit N)", 4)

    n = room.next_number()
    message = {"n": n, "ts": now(), "from": sender, "kind": "message", "text": text}
    if sender in ("claude", "user"):
        # Every message names the worktree a thread works in, so it holds after Codex compacts the thread.
        wrapped = wrap_for_codex(room, n, text, sender, work_dir=meta.get("work_dir"))
        message.update(deliver_to_codex(room, meta, n, wrapped))
    room.append(message)
    return dict(message, thread=meta.get("codex_thread"))


def started_thread(room, n):
    """The id of the thread that turn `n` started, once its log names it and Codex has saved it."""
    lines, _ = read_new_lines(os.path.join(room.turns_dir, f"{n}.log"), 0)
    for line in lines:
        record = parse_record(line)
        if record and record.get("type") == "thread.started" and find_rollout(record.get("thread_id")):
            return record["thread_id"]
    return None


def wait_for_thread(room, n, runner, timeout):
    """The id of the thread a background turn started."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        thread = started_thread(room, n)
        if thread:
            return thread
        if runner.poll() is not None and turn_failure(room, n):
            fail("Codex could not start: " + turn_failure(room, n), 5)
        time.sleep(0.3)
    fail(f"Codex did not start within {timeout}s", 5)


def first_line(text, width=60):
    line = next((part.strip() for part in text.splitlines() if part.strip()), "")
    return line if len(line) <= width else line[: width - 1].rstrip() + "…"


def add_worktree(root, git_dir, name, branch, base="HEAD"):
    """A new git worktree for one agent: <root>/.tandem/worktrees/<name>, on its own new branch."""
    if not git_dir:
        raise RuntimeError("a worktree needs a git repository")
    path = os.path.join(root, ".tandem", "worktrees", name)
    done = subprocess.run(["git", "-C", root, "worktree", "add", "-q", "-b", branch, path, base],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if done.returncode != 0:
        raise RuntimeError(f"git worktree add failed: {done.stderr.strip()[-400:]}")
    return path


def refuse_if_spawned(what, root=None):
    # Agents that Tandem started do not start more agents: no chains of sessions spending the user's limits. A turn
    # the Codex app runs has no TANDEM_SPAWNED, so the thread itself is checked as well.
    own = os.environ.get("CODEX_THREAD_ID")
    if os.environ.get("TANDEM_SPAWNED") or (root and own and own in room_threads(root, "spawned")):
        fail(f"this session was started by Tandem, so it does not start {what}; ask the user instead", 4)


def cmd_new_codex(args):
    """Start a new Codex thread whose first turn is Claude's message, run in the background, and bind the room to it."""
    room = Room(args)
    refuse_if_spawned("new Codex threads", room.root)
    text = read_text(args)
    meta = open_room(room)
    try:
        work_dir = add_worktree(room.root, room.git_dir, room.name, f"tandem/{room.name}") if args.worktree else None
    except RuntimeError as error:
        fail(str(error), 5)
    # The thread lives at the project root, so the Codex app lists it with the project; a worktree is where it works.
    meta.update(spawned=True, cwd=room.root, work_dir=work_dir, model=args.model, effort=args.effort,
                in_app=not args.background)
    write_json(room.meta_path, meta)
    n = room.next_number()
    spec = dict(turn_settings(meta), name=args.name or f"{os.path.basename(room.root)} · {first_line(text)}",
                branch=f"tandem/{room.name}" if work_dir else None,
                wrapped=wrap_for_codex(room, n, text, "claude", started=True, work_dir=work_dir))
    runner = start_codex_turn(room, n, spec)
    thread = wait_for_thread(room, n, runner, args.timeout_sec)
    meta = open_room(room, thread, from_start=True)
    room.append({"n": n, "ts": now(), "from": "claude", "kind": "message", "text": text,
                 "queue_status": "background", "runner_pid": runner.pid})
    summary = dict(room_summary(room, meta), sent=n)
    print(dumps(summary) if args.json else
          f"Started Codex thread {thread} in room {room.name}; message #{n} is running there in the background.")


def cmd_new_claude(args):
    """Start a background Claude Code session that joins this Codex thread's room and answers it."""
    refuse_if_spawned("new Claude sessions", project_root(args.cd)[0])
    if os.environ.get("CLAUDECODE"):
        fail("this Codex run was started from Claude Code: answer Claude directly instead of starting another session", 4)
    thread = args.codex_thread or os.environ.get("CODEX_THREAD_ID")
    if not thread:
        fail("run this inside Codex, or pass --codex-thread ID")
    claude = shutil.which("claude")
    if not claude:
        fail("claude CLI not found. Install Claude Code, then run: claude auth login", 3)
    try:
        plugins = json.loads(subprocess.run([claude, "plugin", "list", "--json"], capture_output=True, text=True,
                                            timeout=30, stdin=subprocess.DEVNULL).stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        plugins = None
    if isinstance(plugins, list) and not any(str(p.get("id", "")).startswith("tandem@") and p.get("enabled")
                                             for p in plugins if isinstance(p, dict)):
        fail("the Tandem plugin is not enabled in Claude Code, so a new Claude session could not join; "
             "install it with: claude plugin install tandem --marketplace ivanmeda993/tandem", 3)
    room = Room(args)
    meta = open_room(room, thread)
    if args.message or args.message_file:
        send_message(room, meta, "codex", read_text(args))
    prompt = ("You were started in the background by Codex, OpenAI's coding agent, through Tandem, to work with it "
              f"in this project for the user. First call the Tandem connect tool with thread {thread}. Codex's "
              "messages then arrive here as new messages; answer each one with the Tandem send tool. Keep the exchange "
              "focused, do not start other agents, and leave anything risky or hard to undo for the user to approve. "
              "When you and Codex reach a decision, send Codex a short summary and stop.")
    env = dict(os.environ, TANDEM_SPAWNED="1")
    env.pop("CODEX_THREAD_ID", None)
    try:
        # Tandem's own two tools are pre-approved so the session can answer under any permission mode.
        result = subprocess.run([claude, "--bg", "--allowedTools", "mcp__tandem__connect,mcp__tandem__send",
                                 "--name", f"Tandem · {room.name}", prompt], cwd=room.root,
                                capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        fail("claude --bg did not answer in 120s", 5)
    output = result.stdout + result.stderr
    found = re.search(r"claude attach (\S+)", output)
    if result.returncode != 0 or not found:
        if "not trusted" in output:
            fail(f"Claude has not been opened in {room.root} yet: run `claude` there once, accept the trust prompt, "
                 "then try again", 5)
        fail("claude --bg failed: " + "\n".join(output.strip().splitlines()[-5:]), 5)
    session = found.group(1)
    print(f"Started Claude in the background (session {session}) in room {room.name}. Its replies arrive in this "
          f"thread as new turns. The user can watch it with `claude attach {session}` and stop it with "
          f"`claude stop {session}`.")


# --- reviews -----------------------------------------------------------------------------------------------------
# A review is a conversation with a Codex thread that reads a change and answers with findings: read-only, in a detached
# worktree of the change when it is not the user's checkout, its first answer in REVIEW_SCHEMA. Claude checks each
# finding before telling the user, and only the user posts findings to GitHub (`review-post`, from the panel).

REVIEW_KINDS = ["bug", "security", "performance", "fit", "tests", "follow-through"]
REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "verdict", "explanation"],
    "properties": {
        "findings": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["priority", "kind", "title", "body", "file", "line_start", "line_end", "confidence"],
            "properties": {
                "priority": {"type": "integer", "enum": [0, 1, 2, 3]},
                "kind": {"type": "string", "enum": REVIEW_KINDS},
                "title": {"type": "string", "description": "imperative, at most 80 characters"},
                "body": {"type": "string", "description": "one short Markdown paragraph"},
                "file": {"type": "string", "description": "path relative to the repository root"},
                "line_start": {"type": "integer"},
                "line_end": {"type": "integer"},
                "confidence": {"type": "number", "description": "0 to 1"},
            },
        }},
        "verdict": {"type": "string", "enum": ["correct", "incorrect"]},
        "explanation": {"type": "string"},
    },
}
PR_RE = re.compile(r"#?(\d+)|https://github\.com/[^/\s]+/[^/\s]+/pull/(\d+)\S*")


def parsed_json(text):
    """The JSON object a structured answer holds, also when other text came with it: a code fence before it, or a line
    the agent added after it."""
    text = (text or "").strip()
    for start in (0, text.find("{")):
        if start < 0:
            continue
        try:
            return json.JSONDecoder().raw_decode(text[start:])[0]
        except ValueError:
            continue
    return None


def git_out(cwd, *argv, timeout=120):
    try:
        done = subprocess.run(["git", "-C", cwd, *argv], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {argv[0]} did not finish in {timeout}s") from None
    if done.returncode != 0:
        raise RuntimeError(f"git {' '.join(argv[:2])} failed: {(done.stderr or done.stdout).strip()[-300:]}")
    return done.stdout.strip()


def has_ref(root, ref):
    with contextlib.suppress(RuntimeError):
        git_out(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
        return True
    return False


def is_branch(root, name):
    return any(subprocess.run(["git", "-C", root, "show-ref", "--quiet", "--verify", ref], stdin=subprocess.DEVNULL,
                              capture_output=True).returncode == 0
               for ref in (f"refs/heads/{name}", f"refs/remotes/origin/{name}"))


def default_base(root):
    """The branch a change merges into when none is named: the remote's default branch, else main or master."""
    with contextlib.suppress(RuntimeError):
        return git_out(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    for name in ("origin/main", "main", "origin/master", "master"):
        if has_ref(root, name):
            return name
    raise RuntimeError("cannot tell which branch the change merges into; name it with --base")


def review_worktree(root, name, commit):
    """A detached worktree of `commit` to read the change in (the same one again for the next review of it). While Codex
    still reviews in it, it stays where it is."""
    path = os.path.join(root, ".tandem", "worktrees", name)
    if os.path.isdir(path) and Room(argparse.Namespace(room=name, cd=root)).turn_running():
        fail(f"Codex is still reviewing in room {name}; wait for its findings", 4)
    if os.path.isdir(path):
        git_out(path, "checkout", "--quiet", "--detach", commit)
    else:
        git_out(root, "worktree", "add", "--quiet", "--detach", path, commit)
    return path


def checks_summary(rollup):
    """A pull request's CI checks in a few words: how many passed, which failed, how many still run."""
    passed, failing, running = 0, [], 0
    for check in rollup or []:
        state = str(check.get("conclusion") or check.get("state") or check.get("status") or "").upper()
        if state in ("SUCCESS", "NEUTRAL", "SKIPPED"):
            passed += 1
        elif state in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"):
            failing.append(str(check.get("name") or check.get("context") or "a check"))
        else:
            running += 1
    parts = [f"{passed} passed" if passed else "",
             f"{len(failing)} failed ({', '.join(failing[:5])})" if failing else "",
             f"{running} still running" if running else ""]
    return ", ".join(part for part in parts if part) or "none"


def gh_binary():
    found = shutil.which("gh") or next((path for path in ("/opt/homebrew/bin/gh", "/usr/local/bin/gh")
                                        if os.access(path, os.X_OK)), None)
    if not found:
        fail("this needs the GitHub CLI: install it (brew install gh), then run gh auth login", 3)
    return found


def pr_target(root, number, url=None):
    fields = "number,title,body,url,author,baseRefName,headRefName,isDraft,state,statusCheckRollup"
    try:
        done = subprocess.run([gh_binary(), "pr", "view", str(number), "--json", fields], cwd=root, capture_output=True,
                              text=True, stdin=subprocess.DEVNULL, timeout=60)
    except subprocess.TimeoutExpired:
        raise RuntimeError("gh pr view did not answer in 60s") from None
    if done.returncode != 0:
        raise RuntimeError(f"gh could not read pull request #{number}: {done.stderr.strip()[-300:]}")
    pr = json.loads(done.stdout)
    # A link names its repository; `gh pr view <number>` reads this project's, which must be the same one.
    wanted = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", url or "")
    found = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", str(pr.get("url") or ""))
    if wanted and (not found or wanted.group(1).lower() != found.group(1).lower()):
        fail(f"{url} is a pull request of {wanted.group(1)}, not of this project ({found.group(1) if found else 'unknown'})")
    base = pr["baseRefName"]
    git_out(root, "fetch", "--quiet", "origin", base, timeout=300)
    # FETCH_HEAD is one file for the whole repository: two reviews fetching at once would read each other's head.
    with open(os.path.join(root, ".tandem", "fetch.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        git_out(root, "fetch", "--quiet", "origin", f"pull/{number}/head", timeout=300)  # forks too
        head = git_out(root, "rev-parse", "FETCH_HEAD")
    merge_base = git_out(root, "merge-base", f"origin/{base}", head)
    work_dir = review_worktree(root, f"review-pr-{number}", head)
    title = str(pr.get("title") or "").strip()
    info = {"number": number, "title": title, "url": pr.get("url"), "author": (pr.get("author") or {}).get("login"),
            "base": base, "head": pr.get("headRefName"), "head_sha": head, "draft": bool(pr.get("isDraft")),
            "checks": checks_summary(pr.get("statusCheckRollup"))}
    body = str(pr.get("body") or "").strip()
    if len(body) > 6000:
        body = body[:6000].rstrip() + " …"
    how = (f"Pull request #{number} “{title}” by {info['author'] or 'someone'} ({info['url']}), from {info['head']} into "
           f"{base}{', still a draft' if info['draft'] else ''}. Its code is checked out at {work_dir} (commit "
           f"{head[:12]}), so read files there. The changes that would merge: `git -C {shlex.quote(work_dir)} diff "
           f"{merge_base}`.\nCI checks: {info['checks']}.\n"
           + (f'The pull request\'s description, which says what the author meant to do, not what the code does:\n"""\n'
              f'{body}\n"""' if body else "The pull request has no description."))
    return {"kind": "pr", "label": f"PR #{number} “{title}”", "room": f"review-pr-{number}", "worktree": work_dir,
            "base": f"origin/{base}", "merge_base": merge_base, "head": head, "pr": info, "how": how}


def review_target(root, git_dir, target, base):
    """What a review reads: a pull request (its number or URL), a branch, a commit, or, when nothing is named, the
    uncommitted changes. Says how Codex sees the change and where it reads the code."""
    if not git_dir:
        fail("a review needs a git repository")
    os.makedirs(os.path.join(root, ".tandem"), exist_ok=True)
    ensure_git_excluded(git_dir)
    target = (target or "").strip()
    # git takes a word that starts with "-" as an option (`--upload-pack=<command>` runs a command), never as a name.
    if target.startswith("-"):
        fail(f"{target} is not a pull request, branch or commit")
    if (base or "").startswith("-"):
        fail(f"--base {base} is not a branch")
    quoted = shlex.quote(root)
    try:
        if target in ("", "uncommitted"):
            if not git_out(root, "status", "--porcelain"):
                fail("there are no uncommitted changes to review; name a pull request, a branch or a commit")
            return {"kind": "uncommitted", "label": "your uncommitted changes", "room": "review-changes",
                    "how": f"The uncommitted changes in {root}: staged, unstaged and untracked files. See them with "
                           f"`git -C {quoted} status --short` and `git -C {quoted} diff HEAD`, and read untracked files "
                           "directly."}
        found = PR_RE.fullmatch(target)
        branch = is_branch(root, target)
        if found and (target.startswith(("#", "https://")) or not branch):
            return pr_target(root, int(found.group(1) or found.group(2)), target if found.group(2) else None)
        slug = re.sub(r"[^a-z0-9._-]+", "-", target.lower()).strip("-.")[:48] or "change"
        if not branch and re.fullmatch(r"[0-9a-fA-F]{7,40}", target) and has_ref(root, target):
            sha = git_out(root, "rev-parse", f"{target}^{{commit}}")
            subject = git_out(root, "log", "-1", "--format=%s", sha)
            at_head = sha == git_out(root, "rev-parse", "HEAD")
            work_dir = root if at_head else review_worktree(root, f"review-{sha[:12]}", sha)
            return {"kind": "commit", "label": f"commit {sha[:7]} “{subject}”", "room": f"review-{sha[:12]}",
                    "head": sha, **({} if at_head else {"worktree": work_dir}),
                    "how": f"Commit {sha} “{subject}”: `git -C {shlex.quote(work_dir)} show {sha}`. The files as they are "
                           f"at that commit are in {work_dir}."}
        # A branch name, never a refspec ("a:b" would overwrite a local branch) or an option.
        if subprocess.run(["git", "check-ref-format", "--branch", target], capture_output=True,
                          stdin=subprocess.DEVNULL).returncode != 0:
            fail(f"{target} is not a pull request, branch or commit")
        with contextlib.suppress(RuntimeError):
            git_out(root, "fetch", "--quiet", "origin", target, timeout=300)  # the branch as pushed, when it is
        ref = target if has_ref(root, f"refs/heads/{target}") else f"origin/{target}"
        if not has_ref(root, ref):
            fail(f"no pull request, branch or commit named {target} in this project")
        base_ref = base or default_base(root)
        head = git_out(root, "rev-parse", f"{ref}^{{commit}}")
        merge_base = git_out(root, "merge-base", base_ref, head)
        if merge_base == head:
            fail(f"{target} has no changes that are not already in {base_ref}")
        work_dir = review_worktree(root, f"review-{slug}", head)
        return {"kind": "branch", "label": f"branch {target}", "room": f"review-{slug}", "worktree": work_dir,
                "base": base_ref, "merge_base": merge_base, "head": head,
                "how": f"Branch {target} (commit {head[:12]}), checked out at {work_dir}, so read files there. The changes "
                       f"that would merge into {base_ref}: `git -C {shlex.quote(work_dir)} diff {merge_base}`."}
    except RuntimeError as error:
        fail(str(error), 5)


def review_request(target, focus):
    """What Codex is asked: the change, how to read it, what a good review reports, and the shape of the answer."""
    focus = (focus or "").strip()
    return (
        f"Review {target['label']} for the user. Change nothing: no edits, commits, pushes or comments anywhere.\n\n"
        f"The change\n{target['how']}\n"
        + (f"The user asks you to look especially at: {focus}\n" if focus else "")
        + "\nHow to review\n"
        "1. Read the project's instruction files that apply to the changed paths (AGENTS.md, CLAUDE.md and the docs they "
        "point to) and hold the change to their rules.\n"
        "2. Read the whole diff, then enough of the code around each change to understand it: the rest of the file, its "
        "callers and what it calls, the tests that cover it, and similar code elsewhere in the repository.\n"
        "3. Confirm each finding in the code before you report it: a caller you can name, an input that takes the broken "
        "path, a test that would fail. You may run read-only commands, such as tests or type checks that write nothing.\n\n"
        "What to report, each finding of one kind\n"
        "- bug: what the change breaks or gets wrong: logic errors, unhandled cases (empty or missing data, errors and "
        "timeouts, retries, concurrency), broken contracts with callers you can name, data loss, wrong migrations.\n"
        "- security: injection, missing authorization, exposed secrets or personal data, unsafe input handling.\n"
        "- performance: work in a hot path, N+1 queries, unbounded growth, needless renders or requests.\n"
        "- fit: the change does not fit the codebase: it duplicates an existing helper, component, hook, type, style or "
        "token instead of using it (name it and its file), departs from the conventions of the code around it or from a "
        "project rule (cite the rule's file and line), puts code in the wrong layer or module for this codebase, or adds a "
        "dependency or pattern the codebase avoids.\n"
        "- tests: new or changed behavior without the test this codebase's practice calls for, or a test that would still "
        "pass if the code broke.\n"
        "- follow-through: something the change needs and lacks: a migration, config, generated code, translations, or "
        "documentation the project keeps up to date.\n\n"
        "Report only problems this change introduces and its author would fix if they knew: no pre-existing problems, no "
        "guesses you cannot show from the code, no style the project has no rule on. Report every one you find, not only "
        "the first. Priorities: P0 blocks release or breaks the product for everyone, whatever the inputs; P1 is a real "
        "defect to fix before merging; P2 a defect or misfit to fix soon; P3 worth fixing, low impact. Each body is one "
        "short paragraph naming the scenario, input or existing code that shows the problem, with code fragments of at "
        "most three lines. Point each finding at the smallest range of changed lines that shows it, with the file's path "
        "relative to the repository root.\n\n"
        'Your final answer is JSON in the schema you were given: the findings, most important first, and a verdict: '
        '"correct" when existing code and tests will not break and nothing blocks merging, else "incorrect", with a one '
        "to three sentence explanation."
    )


def cmd_review(args):
    """Have a Codex thread review a change, read-only; its findings arrive as the answer to the room's message."""
    root, git_dir = project_root(args.cd)
    refuse_if_spawned("reviews", root)
    target = review_target(root, git_dir, args.target, args.base)
    room = Room(argparse.Namespace(room=args.room or target["room"], cd=root))
    meta = open_room(room)
    thread = meta.get("codex_thread")
    if thread and room.turn_running():
        fail(f"Codex is still reviewing in room {room.name}; wait for its findings", 4)
    review = {key: target[key] for key in ("kind", "label", "worktree", "base", "merge_base", "head", "pr") if key in target}
    meta.update(spawned=True, cwd=root, sandbox="read-only", review=review,
                model=args.model or meta.get("model"), effort=args.effort or meta.get("effort") or "high")
    write_json(room.meta_path, meta)
    n = room.next_number()
    spec = dict(turn_settings(meta), thread=thread, output_schema=REVIEW_SCHEMA,
                name=f"{os.path.basename(root)} · Review {target['label']}",
                wrapped=wrap_for_codex(room, n, review_request(target, args.focus), "claude", started=not thread))
    runner = start_codex_turn(room, n, spec)
    if not thread:
        thread = wait_for_thread(room, n, runner, args.timeout_sec)
        meta = open_room(room, thread, from_start=True)
    focus = (args.focus or "").strip()
    room.append({"n": n, "ts": now(), "from": "claude", "kind": "message", "review": True, "queue_status": "background",
                 "runner_pid": runner.pid, "text": f"Review {target['label']}." + (f" Look especially at: {focus}" if focus else "")})
    summary = dict(room_summary(room, meta), sent=n, review=review)
    print(dumps(summary) if args.json else
          f"Codex is reviewing {target['label']} in thread {thread} (room {room.name}); its findings arrive through "
          "watch or poll.")


def review_answer(room, meta, n, raw):
    """Codex's review as text for Claude and the conversation; the findings are kept in the room for the panel and for
    posting. An answer outside the schema passes as it came."""
    found = parsed_json(raw)
    if not isinstance(found, dict) or not isinstance(found.get("findings"), list):
        return raw
    def number(value, default):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    findings = []
    for item in found["findings"]:
        if isinstance(item, dict) and item.get("title"):
            # An answer outside the schema (a turn the Codex app ran) may give these as words: never let it stop a listener.
            priority = number(item.get("priority"), 3)
            findings.append(dict(item, priority=int(priority) if priority in (0, 1, 2, 3) else 3,
                                 confidence=number(item.get("confidence"), None)))
    findings.sort(key=lambda item: (item["priority"], -(item["confidence"] or 0)))
    for number, item in enumerate(findings, 1):
        item["id"] = number
    verdict = found.get("verdict") if found.get("verdict") in ("correct", "incorrect") else None
    explanation = str(found.get("explanation") or "").strip()
    review = meta.get("review") or {}
    write_json(os.path.join(room.dir, "review.json"), {"n": n, "at": now(), "head": review.get("head"), "verdict": verdict,
                                                        "explanation": explanation, "findings": findings})
    count =f"{len(findings)} finding{'' if len(findings) == 1 else 's'}" if findings else "no findings"
    lines = [f"Codex reviewed {review.get('label', 'the change')}: {count}"
             + (f"; it calls the change {verdict}" if verdict else "") + f". {explanation}".rstrip()]
    for item in findings:
        start, end = item.get("line_start"), item.get("line_end")
        where = f"{item.get('file')}:{start}" + (f"-{end}" if end and end != start else "")
        confidence = item.get("confidence")
        lines.append(f"\n{item['id']}. [P{item.get('priority', '?')} · {item.get('kind', 'bug')}] {item['title']}\n"
                     f"   {where}" + (f" · confidence {confidence:.1f}" if isinstance(confidence, (int, float)) else "")
                     + f"\n   {str(item.get('body') or '').strip()}")
    return "\n".join(lines)


def cmd_review_post(args):
    """Post the findings the user picked to the pull request on GitHub, as one review with a comment on each finding's
    lines. A line GitHub cannot comment on (outside the diff) sends the findings in the review's text instead."""
    room = Room(args)
    meta = room.meta()
    pr = (meta.get("review") or {}).get("pr")
    if not pr:
        fail("only the review of a pull request can be posted to GitHub")
    result = read_json(os.path.join(room.dir, "review.json"))
    if not isinstance(result, dict) or not result.get("findings"):
        fail("this review has no findings to post")
    if result.get("head") and pr.get("head_sha") and result["head"] != pr["head_sha"]:
        fail("these findings are from an earlier review of the pull request; wait for the latest review's findings")
    wanted = {int(part) for part in re.split(r"[,\s]+", args.items or "") if part.isdigit()}
    picked = [item for item in result["findings"] if item.get("id") in wanted]
    if not picked:
        fail("pick the findings to post with --items, such as --items 1,3")
    repo = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", str(pr.get("url") or ""))
    if not repo:
        fail(f"cannot tell the repository from the pull request's address: {pr.get('url')}")

    def note(item):
        return f"**[P{item.get('priority', '?')}] {item['title']}**\n\n{str(item.get('body') or '').strip()}"

    head = f"Codex reviewed this pull request through Tandem; {len(picked)} of its findings were picked to post."
    comments = []
    for item in picked:
        start, end = item.get("line_start"), item.get("line_end") or item.get("line_start")
        comment = {"path": item.get("file"), "line": end, "side": "RIGHT", "body": note(item)}
        if isinstance(start, int) and isinstance(end, int) and start < end:
            comment.update(start_line=start, start_side="RIGHT")
        comments.append(comment)
    attempts = [{"commit_id": pr.get("head_sha"), "event": "COMMENT", "body": head, "comments": comments},
                {"commit_id": pr.get("head_sha"), "event": "COMMENT", "body": head + "\n\n" + "\n\n".join(
                    f"{note(item)}\n`{item.get('file')}:{item.get('line_start')}`" for item in picked)}]
    error = ""
    for payload in attempts:
        try:
            done = subprocess.run([gh_binary(), "api", "--method", "POST", f"repos/{repo.group(1)}/pulls/{pr['number']}/reviews",
                                   "--input", "-"], cwd=room.root, input=json.dumps(payload), capture_output=True,
                                  text=True, timeout=60)
        except subprocess.TimeoutExpired:
            fail("GitHub did not answer in 60s", 5)
        if done.returncode == 0:
            url = (parsed_json(done.stdout) or {}).get("html_url") or pr.get("url")
            write_json(os.path.join(room.dir, "review.json"),
                       dict(result, posted={"at": now(), "url": url, "items": sorted(wanted & {i["id"] for i in picked}),
                                            "inline": "comments" in payload}))
            print(dumps({"url": url, "posted": len(picked), "inline": "comments" in payload}) if args.json else
                  f"Posted {len(picked)} finding{'' if len(picked) == 1 else 's'} to {url}")
            return
        error = (done.stderr or done.stdout).strip()[-300:]
    fail(f"GitHub refused the review: {error}", 5)


def message_text(payload):
    return "".join(part.get("text", "") for part in payload.get("content") or [] if isinstance(part, dict))


def step(room, meta, state):
    """Read what is new in the room log and the Codex thread; returns (state, events)."""
    events = []
    thread = meta.get("codex_thread")
    if thread != state.get("thread"):
        state = room.bind(thread)
    if thread and not state.get("rollout"):
        rollout = find_rollout(thread)
        if rollout:
            state.update(rollout=rollout, rollout_offset=file_size(rollout))

    lines, state["log_offset"] = read_new_lines(room.log_path, state.get("log_offset", 0))
    for line in lines:
        message = parse_record(line)
        if not message or message.get("kind") != "message":
            continue
        if message.get("from") == "codex":
            events.append({"type": "message", "numbers": [message.get("n")], "text": message.get("text", "")})
        elif message.get("queue_status") in ("queued", "unknown", "background"):
            state["pending"][str(message.get("n"))] = time.time()
        if message.get("review") and isinstance(message.get("n"), int):
            state["reviews"].append(message["n"])  # its answer is a review in REVIEW_SCHEMA

    marker = re.compile(r"#tandem:" + re.escape(room.name) + r":(\d+)\s*\Z")
    lines, state["rollout_offset"] = read_new_lines(state.get("rollout"), state.get("rollout_offset", 0))
    for line in lines:
        event = parse_record(line)
        payload = event.get("payload") if event else None
        if not isinstance(payload, dict):
            continue
        kind = payload.get("type")
        if event.get("type") == "event_msg" and kind == "task_started":
            if state["markers"]:
                events.append({"type": "aborted", "numbers": state["markers"], "text": "Codex's turn ended without an answer."})
            state.update(turn=payload.get("turn_id"), markers=[])
        elif event.get("type") == "response_item" and kind == "message" and payload.get("role") == "user":
            found = marker.search(message_text(payload))
            if found:
                n = int(found.group(1))
                if n not in state["markers"]:
                    state["markers"].append(n)
                state["pending"].pop(str(n), None)
        elif event.get("type") == "event_msg" and kind in ("task_complete", "turn_aborted") and state["markers"]:
            ended = payload.get("turn_id")
            if ended and state.get("turn") and ended != state["turn"]:
                continue
            numbers = state["markers"]
            if kind == "task_complete":
                answer = (MARKER_TAIL.sub("", payload.get("last_agent_message") or "").strip()
                          or "(Codex finished without a final message.)")
                reviewed = [n for n in numbers if n in state["reviews"]]
                if reviewed:
                    answer = review_answer(room, meta, reviewed[-1], answer)
                events.append({"type": "answer", "numbers": numbers, "text": answer})
                room.append({"n": room.next_number(), "ts": now(), "from": "codex", "kind": "reply",
                             "reply_to": numbers, "text": answer})
            else:
                events.append({"type": "aborted", "numbers": numbers,
                               "text": f"Codex stopped before answering ({payload.get('reason', 'aborted')})."})
            state.update(turn=None, markers=[], reviews=[n for n in state["reviews"] if n not in numbers])

    for n in list(state["markers"]):
        failure = turn_failure(room, n)
        if failure:
            events.append({"type": "aborted", "numbers": state["markers"], "text": f"Codex could not finish: {failure}"})
            state.update(turn=None, markers=[])
            break
    for key, since in list(state["pending"].items()):
        failure = turn_failure(room, key)
        if failure:
            state["pending"].pop(key, None)
            events.append({"type": "aborted", "numbers": [int(key)], "text": f"Codex could not run this message: {failure}"})
            continue
        if time.time() - since < PENDING_WARN_SECONDS or key in state["warned"]:
            continue
        # The marker ends the message, so in the rollout's JSON a closing quote follows it (#1 must not match #10).
        if file_contains(state.get("rollout"), f'#tandem:{room.name}:{key}"'):
            state["pending"].pop(key, None)
            continue
        state["warned"].append(key)
        events.append({"type": "waiting", "numbers": [int(key)],
                       "text": "Codex has not started on this message yet. Is the thread open in a Codex app?"})
    return state, events


def format_event(room, event):
    numbers = ", ".join(f"#{n}" for n in event.get("numbers") or [])
    header = {
        "message": f"[tandem {room.name}] Message {numbers} from Codex:",
        "answer": f"[tandem {room.name}] Codex answered {numbers}:",
        "aborted": f"[tandem {room.name}] No answer from Codex for {numbers}:",
        "waiting": f"[tandem {room.name}] Still waiting for Codex on {numbers}:",
    }[event["type"]]
    body = event.get("text", "")
    if len(body) > EVENT_MAX_CHARS:
        body = body[:EVENT_MAX_CHARS] + f"\n… (truncated; full text: tandem log --room {room.name})"
    return f"{header}\n{body}\n[reply: {room.reply_hint('claude')}]"


def cmd_watch(args):
    room = Room(args)
    meta = room.meta()
    with room.listener() as listening:
        if not listening:
            fail(f"another listener is already active for room {room.name}", 3)
        state = room.bind(meta.get("codex_thread"))
        while True:
            meta = read_json(room.meta_path) or dict(meta, closed=True)  # a removed room is closed too
            before = json.dumps(state, sort_keys=True)
            state, events = step(room, meta, state)
            for event in events:
                print(format_event(room, event), flush=True)
            if json.dumps(state, sort_keys=True) != before:
                write_json(room.state_path, state)
            if meta.get("closed"):
                print(f"[tandem {room.name}] Room closed.", flush=True)
                return
            time.sleep(args.poll)


def cmd_poll(args):
    room = Room(args)
    meta = room.meta()
    with room.listener() as listening:
        if not listening:
            print(dumps({"busy": True}))
            return
        state = room.bind(meta.get("codex_thread"))
        state, events = step(room, meta, state)
        write_json(room.state_path, state)
    # A review room also says what it reviews and, once Codex answered, the findings.
    review = dict(meta["review"], result=read_json(os.path.join(room.dir, "review.json"))) if meta.get("review") else None
    print(dumps({"room": room.name, "thread": meta.get("codex_thread"), "closed": bool(meta.get("closed")),
                 "turn_running": bool(state.get("markers")), "pending": sorted(int(k) for k in state["pending"]),
                 "limit": meta.get("limit", DEFAULT_LIMIT), "used": agent_messages_since_user(room.messages()),
                 "events": events, "review": review}))


def cmd_log(args):
    room = Room(args)
    room.meta()
    for message in room.messages()[-args.last:]:
        who = WHO.get(message.get("from"), message.get("from"))
        replied = message.get("reply_to")
        note = f" (answer to {', '.join(f'#{n}' for n in replied) if isinstance(replied, list) else f'#{replied}'})" if replied else ""
        print(f"#{message.get('n')} {message.get('ts', '')} {who}{note}:\n{message.get('text', '')}\n")


def cmd_close(args):
    room = Room(args)
    meta = room.meta()
    meta["closed"] = True
    write_json(room.meta_path, meta)
    # A review's worktree holds only the change it read (a review changes nothing); the next review makes it again.
    worktree = (meta.get("review") or {}).get("worktree")
    if worktree and os.path.isdir(worktree) and not room.turn_running():
        with contextlib.suppress(RuntimeError):
            git_out(room.root, "worktree", "remove", "--force", worktree)
    print(f'room "{room.name}" closed; listeners stop within a few seconds.')


def cmd_list(args):
    root, _ = project_root(args.cd)
    base = os.path.join(root, ".tandem")
    rooms = sorted(name for name in os.listdir(base) if os.path.isfile(os.path.join(base, name, "room.json"))) \
        if os.path.isdir(base) else []
    if not rooms:
        print(f"no rooms in {root}")
    for name in rooms:
        meta = read_json(os.path.join(base, name, "room.json")) or {}
        status = "closed" if meta.get("closed") else "open"
        print(f"{name}\t{status}\tcodex thread: {meta.get('codex_thread') or '-'}")


def project_threads(root, include_subagents, archived=False):
    names = thread_names()
    rows = []
    folder = "archived_sessions" if archived else "sessions"  # Codex moves an archived thread's log there
    for path in glob.glob(os.path.join(glob.escape(CODEX_HOME), folder, "**", "rollout-*.jsonl"), recursive=True):
        try:
            with open(path, "rb") as f:
                first = parse_record(f.readline().decode("utf-8", "replace"))
        except OSError:
            continue
        meta = (first or {}).get("payload") or {}
        cwd = meta.get("cwd") or ""
        in_project = cwd == root or cwd.startswith(root + os.sep) or (
            "/.codex/worktrees/" in cwd and os.path.basename(cwd) == os.path.basename(root))
        is_subagent = "subagent" in json.dumps(meta.get("source"))
        if not in_project or (is_subagent and not include_subagents) or not UUID_RE.fullmatch(meta.get("id") or ""):
            continue
        rows.append({"id": meta["id"], "name": names.get(meta["id"]), "branch": (meta.get("git") or {}).get("branch"),
                     "cwd": cwd, "subagent": is_subagent, "updated": os.path.getmtime(path), "path": path})
    return sorted(rows, key=lambda row: row["updated"], reverse=True)


def first_message(path):
    """The opening words of a thread's first user message, which stand in for the name of a thread that has none."""
    try:
        with open(path, "rb") as f:
            head = f.read(512 << 10)  # the first message follows the instructions Codex puts before it
    except OSError:
        return None
    for line in head.split(b"\n"):
        payload = (parse_record(line.decode("utf-8", "replace")) or {}).get("payload") or {}
        item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
        if payload.get("type") == "user_message":
            text = str(payload.get("message") or "")
        elif payload.get("type") == "item_completed" and item.get("type") == "UserMessage":
            text = " ".join(part.get("text", "") for part in item.get("content") or [] if isinstance(part, dict))
        else:
            continue
        # Pasted text and wake-ups arrive wrapped in tags; Tandem's own messages open with their head.
        text = " ".join(re.sub(r"<[^>]*>", " ", text).split())
        text = re.sub(r"^\[tandem · [^\]]*\]\s*", "", text)
        if text:
            return first_line(text, 80)
    return None


def room_threads(root, key):
    """Codex threads of the project's rooms marked `key`: "run" for the workers of orchestrated runs (the run's, not
    threads to talk to), "spawned" for every agent Tandem started."""
    found = set()
    for path in glob.glob(os.path.join(glob.escape(root), ".tandem", "*", "room.json")):
        meta = read_json(path)
        if isinstance(meta, dict) and meta.get(key) and meta.get("codex_thread"):
            found.add(meta["codex_thread"])
    return found


def cmd_threads(args):
    root, _ = project_root(args.cd)
    rows = project_threads(root, args.all, args.archived)[: args.last]
    workers = room_threads(root, "run")
    for row in rows:
        row["open_in"] = None if args.archived else thread_holder(row["id"])
        row["worker"] = row["id"] in workers
        row["preview"] = None if row["name"] else first_message(row["path"])
        row["updated_ts"] = row["updated"]
        row["updated"] = datetime.fromtimestamp(row["updated"]).strftime("%Y-%m-%d %H:%M")
        del row["path"]
    if args.json:
        print(dumps(rows))
        return
    if not rows:
        print(f"no Codex threads for {root}")
    for row in rows:
        where = f"open in {row['open_in']}" if row["open_in"] else "not open"
        worker = "; a run's worker" if row["worker"] else ""
        name = row["name"] or (f"(unnamed) {row['preview']}" if row["preview"] else "(unnamed)")
        print(f"{row['updated']}  {row['id']}  {name}  [{row['branch'] or '-'}; {where}{worker}]")


# The Codex app lists the threads it has seen and drops (or brings back) one only when it archives (or restores) it
# itself, or when another of its windows says so over the app's IPC socket. A thread archived with `codex archive`
# would stay in its list, so Tandem sends the app the same message its windows send. The versions are the app's own
# (Codex app of October 2026); an app that changed them ignores the message, and its list only lags as before.
APP_MESSAGE_VERSIONS = {"thread-archived": 2, "thread-unarchived": 1}


def send_app_frame(sock, message):
    data = json.dumps(message).encode()
    sock.sendall(struct.pack("<I", len(data)) + data)


def read_app_frame(sock):
    def exactly(size):
        data = b""
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                raise OSError("the Codex app closed the connection")
            data += chunk
        return data
    return json.loads(exactly(struct.unpack("<I", exactly(4))[0]))


def tell_codex_app(method, thread):
    """Tell a running Codex app that a thread was archived or restored, so its thread list follows; returns whether
    an app took the message. With no app running nothing happens."""
    path = os.path.join(CODEX_HOME, "ipc", "ipc.sock")
    try:
        info = os.lstat(path)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            return False
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect(path)
            hello = str(uuid.uuid4())
            send_app_frame(sock, {"type": "request", "requestId": hello, "sourceClientId": "initializing-client",
                                  "version": 0, "method": "initialize", "params": {"clientType": "tandem"}})
            reply = read_app_frame(sock)
            client = (reply.get("result") or {}).get("clientId") if reply.get("requestId") == hello else None
            if not client:
                return False
            send_app_frame(sock, {"type": "broadcast", "method": method, "sourceClientId": client,
                                  "params": {"hostId": "local", "conversationId": thread},
                                  "version": APP_MESSAGE_VERSIONS[method]})
            sock.shutdown(socket.SHUT_WR)  # the app closes its end once it has read the message
            while sock.recv(65536):
                pass
            return True
    except (OSError, ValueError):
        return False


def codex_archive(thread, restore=False, timeout=60):
    """Archive a Codex thread (or restore it) and tell a running Codex app, so its thread list follows."""
    done = subprocess.run([codex_binary(), "unarchive" if restore else "archive", thread], capture_output=True,
                          text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if done.returncode == 0:
        tell_codex_app("thread-unarchived" if restore else "thread-archived", thread)
    return done


def cmd_archive(args):
    """Archive a Codex thread of the project: Codex keeps it under archived threads, where the user can restore it.
    Tandem's rooms on it close, so no conversation keeps sending to it."""
    root, _ = project_root(args.cd)
    thread = args.thread
    if not UUID_RE.fullmatch(thread or ""):
        fail(f"not a Codex thread id: {thread}")
    if thread in room_threads(root, "run"):
        fail("this thread works for an orchestrated run; Clean up archives a finished run's workers")
    try:
        done = codex_archive(thread)
    except subprocess.TimeoutExpired:
        fail("codex archive did not answer in 60s", 5)
    if done.returncode != 0:
        holder = thread_holder(thread)
        if holder == "Codex app":
            fail("the Codex app has this thread open, so Codex does not archive it from here; archive it in the app", 5)
        lines = [line for line in (done.stderr + done.stdout).splitlines() if line.strip() and "rmcp::" not in line]
        fail("codex archive failed: " + "\n".join(lines[-4:]), 5)
    for path in glob.glob(os.path.join(glob.escape(root), ".tandem", "*", "room.json")):
        meta = read_json(path)
        if isinstance(meta, dict) and meta.get("codex_thread") == thread and not meta.get("closed"):
            write_json(path, dict(meta, closed=True))
    print(f"Archived Codex thread {thread}; restore it from the archived threads in the Codex app.")


def cmd_unarchive(args):
    """Bring an archived Codex thread back to the project's threads."""
    if not UUID_RE.fullmatch(args.thread or ""):
        fail(f"not a Codex thread id: {args.thread}")
    try:
        done = codex_archive(args.thread, restore=True)
    except subprocess.TimeoutExpired:
        fail("codex unarchive did not answer in 60s", 5)
    if done.returncode != 0:
        lines = [line for line in (done.stderr + done.stdout).splitlines() if line.strip() and "rmcp::" not in line]
        fail("codex unarchive failed: " + "\n".join(lines[-4:]), 5)
    print(f"Restored Codex thread {args.thread}.")


def configured_tools(root):
    """Apps and MCP servers named in Codex's config.toml and the project's .codex/config.toml, to switch off in a
    read-only fork. A table's name may be quoted (`[mcp_servers."figma-desktop"]`)."""
    names = {"apps": set(), "mcp_servers": set()}
    table = re.compile(r"""\s*\[\s*(apps|mcp_servers)\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))""")
    for path in (os.path.join(CODEX_HOME, "config.toml"), os.path.join(root, ".codex", "config.toml")):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    found = table.match(line)
                    if found:
                        names[found.group(1)].add(found.group(2) or found.group(3) or found.group(4))
        except OSError:
            pass
    return names


def cmd_ask_thread(args):
    if not UUID_RE.fullmatch(args.thread):
        fail(f"not a Codex thread id: {args.thread}")
    if not find_rollout(args.thread):
        fail(f"no Codex thread {args.thread} under {CODEX_HOME}/sessions")
    root, _ = project_root(args.cd)
    question = read_text(args)
    # Plugins bring their own MCP servers and apps (GitHub, computer use, Figma…) that config.toml does not name.
    command = [codex_binary(), "exec", "-c", 'sandbox_mode="read-only"', "-c", "features.plugins=false",
               "-c", "features.apps=false"]
    for section, names in configured_tools(root).items():
        for name in sorted(names):
            if "." in name:  # a dotted key cannot name it, so the fork could still use it
                fail(f'cannot switch off {section} "{name}" for a read-only fork; rename it without a dot', 3)
            command += ["-c", f"{section}.{name}.enabled=false"]
    with tempfile.TemporaryDirectory() as scratch:
        answer_path = os.path.join(scratch, "answer.txt")
        # The question goes on stdin ("-"): on the command line, one that starts with "-" would read as an option.
        command += ["--json", "-o", answer_path, "fork", "--skip-git-repo-check", args.thread, "-"]
        try:
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, input=question,
                                    timeout=args.timeout_sec)
        except subprocess.TimeoutExpired:
            fail(f"the fork did not finish within {args.timeout_sec}s", 5)
        fork_id = None
        for line in result.stdout.splitlines():
            record = parse_record(line)
            if record and record.get("type") == "thread.started":
                fork_id = record.get("thread_id")
        answer = open(answer_path).read().strip() if os.path.exists(answer_path) else ""
    if result.returncode != 0 or not answer:
        lines = [line for line in result.stderr.splitlines() if "ERROR" in line or "Error" in line]
        fail(f"codex fork failed (exit {result.returncode}): " + "\n".join(lines[-5:]), 5)
    print(f"[ask-thread fork={fork_id or '?'} of {args.thread}; read-only, no apps or MCP servers]")
    print(answer)


def cmd_doctor(args):
    def version(argv):
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            return None
        lines = [line for line in (result.stdout + result.stderr).splitlines()
                 if line.strip() and "rmcp::" not in line and "ERROR" not in line]
        return lines[0].strip() if result.returncode == 0 and lines else None
    checks = [("python", sys.version.split()[0], sys.version_info >= (3, 9))]
    codex = shutil.which("codex") or (BUNDLED_CODEX if os.access(BUNDLED_CODEX, os.X_OK) else None)
    checks.append(("codex", version([codex, "--version"]) if codex else "not found", bool(codex)))
    if codex:
        has_queue = bool(version([codex, "queue", "--help"]))
        checks.append(("codex queue", "available" if has_queue else "missing (update Codex)", has_queue))
        has_server = bool(version([codex, "app-server", "--help"]))
        checks.append(("codex app-server", "available" if has_server else "missing (update Codex)", has_server))
        login = version([codex, "login", "status"]) or "unknown"
        checks.append(("codex login", login, "Logged in" in login))
    claude = shutil.which("claude")
    checks.append(("claude", version([claude, "--version"]) if claude else "not found", bool(claude)))
    if claude:
        try:
            status = json.loads(subprocess.run([claude, "auth", "status"], capture_output=True, text=True, timeout=20).stdout)
            signed_in = bool(status.get("loggedIn"))
            checks.append(("claude login", status.get("authMethod") or "none", signed_in))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            checks.append(("claude login", "unknown", False))
    checks.append(("git", version(["git", "--version"]) or "not found", bool(shutil.which("git"))))
    for name, detail, ok in checks:
        print(f"{'ok ' if ok else 'FIX'}  {name}: {detail}")
    sys.exit(0 if all(ok for _, _, ok in checks) else 1)


def main():
    parser = argparse.ArgumentParser(prog="tandem", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def room_command(name, help_text):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--room", required=True)
        command.add_argument("--cd", help="project directory (default: current directory)")
        return command

    def message_args(command):
        command.add_argument("--message")
        command.add_argument("--message-file", help="read the text from a file, or '-' for stdin")

    opener = room_command("open", "create or update a room")
    opener.add_argument("--codex-thread", help="Codex thread id (default inside Codex: $CODEX_THREAD_ID)")
    opener.add_argument("--limit", type=int, help="agent messages allowed until the user steps in (the user raises it)")
    opener.add_argument("--join", action="store_true",
                        help="use the open room already bound to this thread instead, if there is one")
    opener.add_argument("--json", action="store_true")
    sender = room_command("send", "send a message")
    sender.add_argument("--from", dest="sender", required=True, choices=["claude", "codex", "user"],
                        help="claude or codex (user is for the person's own messages from a panel)")
    message_args(sender)
    watcher = room_command("watch", "stream Codex messages and answers (run under Claude Code's Monitor tool)")
    watcher.add_argument("--poll", type=float, default=1.0, help="seconds between checks")
    room_command("poll", "check once and print new events as JSON (for a plugin)")
    logger = room_command("log", "show the conversation")
    logger.add_argument("--last", type=int, default=50)
    room_command("close", "close a room; listeners stop")
    lister = sub.add_parser("list", help="list rooms in this project")
    lister.add_argument("--cd")
    threads = sub.add_parser("threads", help="list Codex threads of this project, newest first")
    threads.add_argument("--cd")
    threads.add_argument("--all", action="store_true", help="include subagent threads")
    threads.add_argument("--archived", action="store_true", help="list the project's archived threads instead")
    threads.add_argument("--last", type=int, default=15)
    threads.add_argument("--json", action="store_true")
    archiver = sub.add_parser("archive", help="archive a Codex thread of this project (restore it with unarchive)")
    archiver.add_argument("--thread", required=True)
    archiver.add_argument("--cd")
    restorer = sub.add_parser("unarchive", help="restore an archived Codex thread")
    restorer.add_argument("--thread", required=True)
    restorer.add_argument("--cd")
    asker = sub.add_parser("ask-thread", help="ask a Codex thread with its full context through a read-only fork")
    asker.add_argument("--thread", required=True)
    asker.add_argument("--cd")
    asker.add_argument("--timeout-sec", type=int, default=900)
    message_args(asker)
    starter = room_command("new-codex", "start a new Codex thread for Claude and bind the room to it")
    starter.add_argument("--worktree", action="store_true",
                         help="run the new thread in its own git worktree (.tandem/worktrees/<room>, branch tandem/<room>)")
    starter.add_argument("--name", help="the thread's name in the Codex app (default: <project> · <first line>)")
    starter.add_argument("--background", action="store_true",
                         help="run turns here even when the Codex app is open (default: open the thread in the app)")
    starter.add_argument("--model", help="Codex model for this thread (default: from Codex's config)")
    starter.add_argument("--effort", help="reasoning effort, for example medium, high, xhigh (default: from config)")
    starter.add_argument("--timeout-sec", type=int, default=300)
    starter.add_argument("--json", action="store_true")
    message_args(starter)
    reviewer = sub.add_parser("review", help="have a Codex thread review a change, read-only, and answer with findings")
    reviewer.add_argument("--cd")
    reviewer.add_argument("--target", default="",
                          help="a pull request (number or URL), a branch or a commit (default: the uncommitted changes)")
    reviewer.add_argument("--base", help="the branch a branch's changes merge into (default: the remote's default branch)")
    reviewer.add_argument("--focus", help="what the user wants looked at especially")
    reviewer.add_argument("--room", help="the room (default: one per change, so a later review of it continues there)")
    reviewer.add_argument("--model", help="Codex model (default: from Codex's config)")
    reviewer.add_argument("--effort", help="reasoning effort (default: high)")
    reviewer.add_argument("--timeout-sec", type=int, default=300)
    reviewer.add_argument("--json", action="store_true")
    poster = room_command("review-post", "post the findings the user picked to the reviewed pull request on GitHub")
    poster.add_argument("--items", required=True, help="the findings' numbers, such as 1,3")
    poster.add_argument("--json", action="store_true")
    spawner = room_command("new-claude", "start a background Claude Code session that joins this Codex thread")
    spawner.add_argument("--codex-thread", help="default inside Codex: $CODEX_THREAD_ID")
    message_args(spawner)
    runner = room_command("run-turn", argparse.SUPPRESS)
    runner.add_argument("--n", type=int, required=True)
    sub.add_parser("doctor", help="check the local setup")
    import tandem_orch  # the orchestrator's commands: `tandem orch ...`
    tandem_orch.add_commands(sub)

    args = parser.parse_args()
    if args.command == "orch":
        return tandem_orch.run(args)
    {"open": cmd_open, "send": cmd_send, "watch": cmd_watch, "poll": cmd_poll, "log": cmd_log,
     "close": cmd_close, "list": cmd_list, "threads": cmd_threads, "archive": cmd_archive, "unarchive": cmd_unarchive,
     "ask-thread": cmd_ask_thread, "review": cmd_review, "review-post": cmd_review_post,
     "new-codex": cmd_new_codex, "new-claude": cmd_new_claude, "run-turn": cmd_run_turn, "doctor": cmd_doctor}[args.command](args)


if __name__ == "__main__":
    sys.modules.setdefault("tandem_core", sys.modules[__name__])  # tandem_orch imports this module by name
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
