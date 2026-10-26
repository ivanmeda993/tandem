"""Tests for the Tandem core script and ask-claude, with fake `codex` and `claude` binaries.

Run from the repository root: python3 -m unittest discover -s tests -v
Nothing here calls the real Codex or Claude.
"""

import argparse
import fcntl
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_CHAT = os.path.join(ROOT, "codex-skills", "tandem", "scripts", "tandem")
ASK_CLAUDE = os.path.join(ROOT, "codex-skills", "ask-claude", "scripts", "ask-claude.sh")
THREAD = "01a17000-0000-7000-8000-000000000001"
SESSION = "11111111-2222-3333-4444-555555555555"

NEW_THREAD = "01a17000-0000-7000-8000-000000000099"

FAKE_CODEX = r"""#!/usr/bin/env python3
# Answers `codex queue`, `codex exec` and `codex app-server` (JSON-RPC on stdio) like the real CLI, and writes
# each turn's events to the thread's rollout file the way Codex does. A line "WRITE <path> <text>" in a message
# makes the fake write that file in its working directory, like a worker's edit.
import fcntl, json, os, sys, time
args, fake = sys.argv[1:], os.environ["FAKE_DIR"]
day = os.path.join(os.environ["CODEX_HOME"], "sessions", "2026", "10", "25")

def rollout(thread):
    for name in os.listdir(day):
        if name.endswith(thread + ".jsonl"):
            return os.path.join(day, name)
    return os.path.join(day, "rollout-2026-10-25T11-00-00-" + thread + ".jsonl")

PROPOSALS = {"status": "proposals", "summary": "two ideas", "items": [
    {"id": 1, "kind": "delete", "where": "x:1", "why": "unused", "risk": "low", "lines_removed": 1,
     "change": "WRITE unused.txt gone", "proof": "tests"},
    {"id": 2, "kind": "merge", "where": "y:2", "why": "duplicate", "risk": "low", "lines_removed": 2,
     "change": "WRITE simpler.txt simpler", "proof": "tests"}]}
REVIEW = {"verdict": "incorrect", "explanation": "An empty name prints a blank greeting.", "findings": [
    {"priority": 2, "kind": "fit", "title": "Use the existing say helper", "body": "`say()` in util.py already does this.",
     "file": "greet.py", "line_start": 1, "line_end": 2, "confidence": 0.7},
    {"priority": 1, "kind": "bug", "title": "Handle an empty name", "body": "An empty name prints `hi `.",
     "file": "greet.py", "line_start": 1, "line_end": 1, "confidence": 0.9}]}

def run_turn(thread, prompt, answer=None):
    for line in prompt.splitlines():
        if line.startswith("WRITE "):
            _, path, text = line.split(" ", 2)
            with open(path, "w") as f:
                f.write(text + "\n")
    turn = "turn-%f" % time.time()
    lines = prompt.splitlines()
    with open(rollout(thread), "a") as f:
        for record in ({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}},
                       {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                             "content": [{"type": "input_text", "text": prompt}]}},
                       {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn,
                                                         "last_agent_message": answer or "ANSWER: " + (lines[2] if len(lines) > 2 else "")}}):
            f.write(json.dumps(record) + "\n")
    return turn

if args[:1] == ["app-server"]:
    def log(value):
        with open(os.path.join(fake, "app-server.jsonl"), "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(json.dumps(value) + "\n")
    def send(value):
        sys.stdout.write(json.dumps(value) + "\n")
        sys.stdout.flush()
    log({"argv": args, "cwd": os.getcwd()})
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        method, params = msg["method"], msg.get("params") or {}
        log({"method": method, "params": params})
        result = {}
        if method == "thread/start":
            with open(os.path.join(fake, "threads-started"), "a+") as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                f.seek(0)
                count = len(f.read().splitlines())
                f.write("x\n")
            thread = "01a17000-0000-7000-8000-%012d" % (99 - count)
            with open(rollout(thread), "w") as f:
                f.write(json.dumps({"type": "session_meta", "payload": {"id": thread, "cwd": params.get("cwd")}}) + "\n")
            result = {"thread": {"id": thread}}
        elif method == "thread/resume":
            result = {"thread": {"id": params["threadId"]}}
        elif method == "turn/start":
            if os.environ.get("FAKE_FAIL") or (os.environ.get("FAKE_FAIL_SCHEMA") and params.get("outputSchema")):
                send({"id": msg["id"], "result": {"turn": {"id": "t-fail", "status": "inProgress"}}})
                send({"method": "turn/completed", "params": {"threadId": params["threadId"], "turn": {
                    "id": "t-fail", "status": "failed", "error": {"message": "fake failure"}}}})
                continue
            send({"method": "account/rateLimits/updated", "params": {"rateLimits": {"primary": {"usedPercent": 12.0}}}})
            # With an output schema, the fake answers in it: a review's findings, or the simplifier's two proposals.
            schema = json.dumps(params.get("outputSchema") or "")
            answer = (json.dumps(REVIEW) if "findings" in schema else json.dumps(PROPOSALS)) if params.get("outputSchema") else None
            turn = run_turn(params["threadId"], params["input"][0]["text"], answer)
            send({"id": msg["id"], "result": {"turn": {"id": turn, "status": "inProgress"}}})
            send({"method": "turn/completed", "params": {"threadId": params["threadId"], "turn": {"id": turn, "status": "completed"}}})
            continue
        send({"id": msg["id"], "result": result})
    sys.exit(0)
if args[:1] == ["queue"]:
    with open(os.path.join(fake, "queued-%017.6f.txt" % time.time()), "w") as f:
        f.write(args[4])
    print("Queued message Q%d for thread %s." % (os.getpid(), args[2]))
    sys.exit(0)
if args[:1] in (["archive"], ["unarchive"]):
    with open(os.path.join(fake, args[0] + "d.txt"), "a") as f:
        f.write(args[1] + "\n")
    sys.exit(0)
if args[:1] == ["exec"]:
    with open(os.path.join(fake, "codex-exec-argv.txt"), "a") as f:
        f.write("\n".join(args) + "\n=====\n")
    if os.environ.get("FAKE_FAIL"):
        print("ERROR: fake failure", file=sys.stderr)
        sys.exit(1)
    if "resume" in args:
        i = args.index("resume")
        thread, prompt = args[i + 2], args[i + 3]
    else:
        thread, prompt = "01a17000-0000-7000-8000-000000000099", args[-1]
    if prompt == "-":
        prompt = sys.stdin.read()
        with open(os.path.join(fake, "codex-exec-prompt.txt"), "w") as f:
            f.write(prompt)
    if "-o" in args:
        with open(args[args.index("-o") + 1], "w") as f:
            f.write("ANSWER: " + prompt)
    if "resume" not in args:
        with open(rollout(thread), "w") as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": thread}}) + "\n")
        print(json.dumps({"type": "thread.started", "thread_id": thread}), flush=True)
    turn = "turn-%f" % time.time()
    lines = prompt.splitlines()
    with open(rollout(thread), "a") as f:
        for record in ({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}},
                       {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                             "content": [{"type": "input_text", "text": prompt}]}},
                       {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn,
                                                         "last_agent_message": "ANSWER: " + (lines[2] if len(lines) > 2 else "")}}):
            f.write(json.dumps(record) + "\n")
    sys.exit(0)
print("codex-cli 0.0.0-test")
"""

FAKE_GH = r"""#!/usr/bin/env python3
# Answers `gh pr view` for pull request #7 and records each review `gh api` posts; FAKE_GH_NO_INLINE refuses inline
# comments, as GitHub does for a line outside the diff.
import json, os, sys
args, fake = sys.argv[1:], os.environ["FAKE_DIR"]
if args[:2] == ["pr", "view"]:
    print(json.dumps({"number": 7, "title": "Add the greeting", "body": "Greets the user.", "author": {"login": "someone"},
                      "url": "https://github.com/acme/app/pull/7", "baseRefName": os.environ["FAKE_GH_BASE"],
                      "headRefName": "greeting", "isDraft": False, "state": "OPEN",
                      "statusCheckRollup": [{"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"},
                                            {"name": "lint", "status": "COMPLETED", "conclusion": "FAILURE"}]}))
    sys.exit(0)
if args[:1] == ["api"]:
    payload = json.loads(sys.stdin.read())
    with open(os.path.join(fake, "gh-reviews.jsonl"), "a") as f:
        f.write(json.dumps({"args": args, "payload": payload}) + "\n")
    if payload.get("comments") and os.environ.get("FAKE_GH_NO_INLINE"):
        print("HTTP 422: Validation Failed", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"html_url": "https://github.com/acme/app/pull/7#pullrequestreview-1"}))
    sys.exit(0)
sys.exit(2)
"""

FAKE_CLAUDE = """#!/bin/sh
# Answers `plugin list --json` and `--bg` like the real CLI; otherwise records argv and stdin
# and answers like `claude -p --output-format json`.
if [ "$1" = plugin ]; then
  if [ -n "$FAKE_NO_TANDEM" ]; then echo '[]'; else echo '[{"id":"tandem@tandem","enabled":true}]'; fi
  exit 0
fi
if [ "$1" = --bg ]; then
  for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/claude-bg-argv.txt"
  env > "$FAKE_DIR/claude-bg-env.txt"
  echo "  claude attach abc12345    open in this terminal"
  exit 0
fi
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/claude-argv.txt"
cat > "$FAKE_DIR/claude-stdin.txt"
printf '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"%s","num_turns":1,"duration_ms":10}' "11111111-2222-3333-4444-555555555555"
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, "repo")
        self.bin = os.path.join(self.tmp, "bin")
        self.codex_home = os.path.join(self.tmp, "codex")
        day = os.path.join(self.codex_home, "sessions", "2026", "10", "25")
        for path in (self.repo, self.bin, day):
            os.makedirs(path)
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.rollout = os.path.join(day, f"rollout-2026-10-25T10-00-00-{THREAD}.jsonl")
        self.write_rollout({"type": "session_meta", "payload": {"id": THREAD, "cwd": self.repo}})
        with open(os.path.join(self.codex_home, "session_index.jsonl"), "w") as f:
            f.write(json.dumps({"id": THREAD, "thread_name": "Test thread"}) + "\n")
        for name, body in (("codex", FAKE_CODEX), ("claude", FAKE_CLAUDE)):
            path = os.path.join(self.bin, name)
            with open(path, "w") as f:
                f.write(body)
            os.chmod(path, 0o755)
        self.env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": os.environ["HOME"], "CODEX_HOME": self.codex_home,
                    "FAKE_DIR": self.tmp, "LANG": "en_US.UTF-8", "TANDEM_NO_APP": "1",  # never open the real Codex app
                    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}

    def commit_initial(self):
        with open(os.path.join(self.repo, "README.md"), "w") as f:
            f.write("test\n")
        for argv in (["add", "README.md"], ["commit", "-q", "-m", "initial"]):
            subprocess.run(["git", "-C", self.repo, *argv], env=self.env, check=True)

    def room_state(self, room, n):
        """What a room and its turn left behind, for a failure message."""
        def tail(path, size):
            if not os.path.exists(path):
                return "missing"
            with open(path) as f:
                return f.read()[-size:]
        parts = [f"{name}: {tail(os.path.join(self.repo, '.tandem', room, name), 1200)}"
                 for name in (f"turns/{n}.exit", f"turns/{n}.log", "watch-state.json", "messages.jsonl")]
        return "\n".join(parts + [f"rollout: {tail(self.rollout, 1500)}"])

    def server_calls(self):
        path = os.path.join(self.tmp, "app-server.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def hold_thread(self, thread):
        """Keep the thread's writer lock open, as a Codex app does while it shows the thread."""
        locks = os.path.join(self.codex_home, "thread-writer-locks")
        os.makedirs(locks, exist_ok=True)
        self.held = open(os.path.join(locks, thread + ".lock"), "w")
        self.addCleanup(self.held.close)

    def app_holds(self, thread):
        """A process that looks like the Codex app keeps the thread's writer lock open."""
        locks = os.path.join(self.codex_home, "thread-writer-locks")
        os.makedirs(locks, exist_ok=True)
        ready = os.path.join(self.codex_home, f"app-ready-{thread}")
        holder = subprocess.Popen([sys.executable, "-c",
                                   "import sys, time; f = open(sys.argv[1], 'w'); open(sys.argv[2], 'w').close(); time.sleep(30)",
                                   os.path.join(locks, thread + ".lock"), ready, "/Applications/ChatGPT.app/Contents/Resources/codex"])
        self.addCleanup(holder.wait)
        self.addCleanup(holder.kill)
        deadline = time.time() + 10
        while not os.path.exists(ready) and time.time() < deadline:
            time.sleep(0.05)

    def wait_for_turn(self, room, n):
        exit_file = os.path.join(self.repo, ".tandem", room, "turns", f"{n}.exit")
        deadline = time.time() + 15
        while not os.path.exists(exit_file) and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(os.path.exists(exit_file), "the background turn did not finish")

    def write_rollout(self, *records):
        with open(self.rollout, "a") as f:
            for record in records:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def chat(self, *args, ok=True, stdin=None):
        result = subprocess.run([AGENT_CHAT, *args, "--cd", self.repo] if args[0] not in ("threads", "doctor") else [AGENT_CHAT, *args],
                                env=self.env, capture_output=True, text=True, input=stdin, timeout=60)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def poll(self, room="r"):
        return json.loads(self.chat("poll", "--room", room).stdout)

    def queued(self):
        files = sorted(name for name in os.listdir(self.tmp) if name.startswith("queued-"))
        texts = []
        for name in files:
            with open(os.path.join(self.tmp, name)) as f:
                texts.append(f.read())
        return texts

    def codex_turn(self, turn, user_text, answer=None, aborted=False):
        self.write_rollout({"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}},
                           {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                                 "content": [{"type": "input_text", "text": user_text}]}})
        if aborted:
            self.write_rollout({"type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": turn, "reason": "interrupted"}})
        elif answer is not None:
            self.write_rollout({"type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn,
                                                                 "last_agent_message": answer}})


class AgentChatTests(Base):
    def setUp(self):
        super().setUp()
        self.hold_thread(THREAD)

    def open_room(self, *extra):
        self.chat("open", "--room", "r", "--codex-thread", THREAD, *extra)

    def test_round_trip_answer(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "Which pages are done?")
        wrapped = self.queued()[-1]
        self.assertTrue(wrapped.rstrip().endswith("#tandem:r:1"))
        self.assertIn("not the user's own instruction", wrapped)
        self.codex_turn("t1", wrapped, answer="Pages 1-4.")
        events = self.poll()["events"]
        self.assertEqual(events, [{"type": "answer", "numbers": [1], "text": "Pages 1-4."}])
        self.assertIn("(answer to #1)", self.chat("log", "--room", "r").stdout)
        self.assertEqual(self.poll()["events"], [])

    def test_line_separator_in_codex_message(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "codex", "--message", "a b")
        self.assertEqual(self.poll()["events"][0]["text"], "a b")
        self.codex_turn("t1", "unrelated", answer="x y")
        self.assertEqual(self.poll()["events"], [])

    def test_unfinished_turn_is_not_answered_by_next_turn(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "Question")
        self.codex_turn("t1", self.queued()[-1])
        self.codex_turn("t2", "the user's private question", answer="PRIVATE ANSWER")
        events = self.poll()["events"]
        self.assertEqual([e["type"] for e in events], ["aborted"])
        self.assertNotIn("PRIVATE", json.dumps(events))

    def test_aborted_turn_reported(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "Question")
        self.codex_turn("t1", self.queued()[-1], aborted=True)
        self.assertEqual(self.poll()["events"][0]["type"], "aborted")

    def test_echoed_marker_is_left_out_of_the_answer(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "Status?")
        self.codex_turn("t1", self.queued()[-1], answer="All good.\n#tandem:r:1")
        self.assertEqual(self.poll()["events"][0]["text"], "All good.")

    def test_waiting_message_is_not_found_in_a_longer_number(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "first")
        self.poll()
        self.codex_turn("t1", "something about #tandem:r:10")
        state_path = os.path.join(self.repo, ".tandem", "r", "watch-state.json")
        with open(state_path) as f:
            state = json.load(f)
        state["pending"] = {key: time.time() - 1000 for key in state["pending"]}
        with open(state_path, "w") as f:
            json.dump(state, f)
        self.assertEqual([(e["type"], e["numbers"]) for e in self.poll()["events"]], [("waiting", [1])])

    def test_plain_files_in_the_tandem_folder(self):
        os.makedirs(os.path.join(self.repo, ".tandem"))
        for name in ("codex-limits.json", "orchestrator.json"):  # what background turns and runs leave there
            with open(os.path.join(self.repo, ".tandem", name), "w") as f:
                f.write("{}\n")
        joined = json.loads(self.chat("open", "--room", "x", "--join", "--codex-thread", THREAD, "--json").stdout)
        self.assertEqual(joined["room"], "x")
        self.assertEqual(self.chat("list").stdout.split("\t")[0], "x")

    def test_quoted_marker_does_not_misattribute(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "first")
        self.chat("send", "--room", "r", "--from", "claude", "--message", "earlier I wrote #tandem:r:1 by mistake")
        self.codex_turn("t1", self.queued()[-1], answer="A2")
        self.assertEqual(self.poll()["events"][0]["numbers"], [2])

    def test_one_listener_per_room(self):
        self.open_room()
        watcher = subprocess.Popen([AGENT_CHAT, "watch", "--room", "r", "--cd", self.repo], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            self.assertEqual(self.poll(), {"busy": True})
            second = self.chat("watch", "--room", "r", ok=False)
            self.assertEqual(second.returncode, 3)
        finally:
            watcher.kill()
            watcher.communicate()

    def test_room_names_validated(self):
        for name in ("..", ".", "a\n", "-x", "a/b"):
            self.assertEqual(self.chat("open", "--room", name, ok=False).returncode, 2, name)

    def test_poll_and_watch_without_thread(self):
        self.chat("open", "--room", "r")
        self.assertEqual(self.poll()["events"], [])

    def test_thread_id_validated(self):
        self.assertEqual(self.chat("open", "--room", "r", "--codex-thread", "*", ok=False).returncode, 2)

    def test_limit_counts_agent_messages_and_user_resets(self):
        self.open_room("--limit", "2")
        self.chat("send", "--room", "r", "--from", "claude", "--message", "one")
        self.codex_turn("t1", self.queued()[-1], answer="reply one")
        self.poll()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "two")
        self.assertEqual(self.chat("send", "--room", "r", "--from", "claude", "--message", "three", ok=False).returncode, 4)
        self.chat("send", "--room", "r", "--from", "user", "--message", "go on")
        self.assertIn("from the user", self.queued()[-1])
        self.chat("send", "--room", "r", "--from", "claude", "--message", "three")

    def test_waiting_notice_once(self):
        self.open_room()
        self.chat("send", "--room", "r", "--from", "claude", "--message", "hello?")
        self.poll()
        state_path = os.path.join(self.repo, ".tandem", "r", "watch-state.json")
        with open(state_path) as f:
            state = json.load(f)
        state["pending"] = {key: time.time() - 1000 for key in state["pending"]}
        with open(state_path, "w") as f:
            json.dump(state, f)
        self.assertEqual([e["type"] for e in self.poll()["events"]], ["waiting"])
        self.assertEqual(self.poll()["events"], [])

    def test_message_limits_and_bad_cd(self):
        self.open_room()
        self.assertEqual(self.chat("send", "--room", "r", "--from", "claude", "--message", "x" * 40000, ok=False).returncode, 2)
        result = subprocess.run([AGENT_CHAT, "open", "--room", "r", "--cd", os.path.join(self.tmp, "missing")],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "missing")))

    def test_threads_lists_project_thread(self):
        result = subprocess.run([AGENT_CHAT, "threads", "--cd", self.repo, "--json"], env=self.env,
                                capture_output=True, text=True)
        rows = json.loads(result.stdout)
        self.assertEqual([(row["id"], row["name"]) for row in rows], [(THREAD, "Test thread")])

    def test_unnamed_threads_show_their_first_words_and_can_be_archived_and_restored(self):
        thread = "01a17000-0000-7000-8000-000000000042"

        def rollout(folder, *records):
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, f"rollout-2026-10-25T12-00-00-{thread}.jsonl"), "w") as f:
                for record in ({"type": "session_meta", "payload": {"id": thread, "cwd": self.repo}},) + records:
                    f.write(json.dumps(record) + "\n")

        # As the Codex app writes a thread: injected instructions first, then the person's message (here pasted).
        rollout(os.path.dirname(self.rollout),
                {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                      "content": [{"type": "input_text", "text": "# AGENTS.md instructions"}]}},
                {"type": "event_msg", "payload": {"type": "item_completed", "item": {
                    "type": "UserMessage", "content": [{"type": "text", "text": '<pasted_content id="1">\nPlan the auth flow\n</pasted_content>'}]}}})
        rows = json.loads(self.chat("threads", "--cd", self.repo, "--json").stdout)
        self.assertEqual(next(row["preview"] for row in rows if row["id"] == thread), "Plan the auth flow")
        self.assertIsNone(next(row["preview"] for row in rows if row["id"] == THREAD))  # a named thread needs none

        self.chat("open", "--room", "x", "--codex-thread", thread)
        self.chat("archive", "--thread", thread)
        with open(os.path.join(self.tmp, "archived.txt")) as f:
            self.assertEqual(f.read().split(), [thread])
        with open(os.path.join(self.repo, ".tandem", "x", "room.json")) as f:
            self.assertTrue(json.load(f)["closed"])  # nothing keeps sending to an archived thread

        rollout(os.path.join(self.codex_home, "archived_sessions"))
        archived = json.loads(self.chat("threads", "--archived", "--cd", self.repo, "--json").stdout)
        self.assertEqual([row["id"] for row in archived], [thread])
        self.chat("unarchive", "--thread", thread)
        with open(os.path.join(self.tmp, "unarchived.txt")) as f:
            self.assertEqual(f.read().split(), [thread])

    def test_a_running_codex_app_hears_of_archived_and_restored_threads(self):
        # Stands for the Codex app's IPC socket: it answers a client's hello and keeps what the client broadcasts.
        thread = "01a17000-0000-7000-8000-000000000042"
        os.makedirs(os.path.join(self.codex_home, "ipc"))
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(os.path.join(self.codex_home, "ipc", "ipc.sock"))
        server.listen()
        self.addCleanup(server.close)
        heard = []

        def frames(conn):
            while True:
                head = conn.recv(4, socket.MSG_WAITALL)
                if len(head) < 4:
                    return
                yield json.loads(conn.recv(struct.unpack("<I", head)[0], socket.MSG_WAITALL))

        def app():
            for n in (1, 2):
                conn, _ = server.accept()
                with conn:
                    for message in frames(conn):
                        if message.get("method") == "initialize":
                            reply = json.dumps({"type": "response", "requestId": message["requestId"],
                                                "resultType": "success", "method": "initialize",
                                                "result": {"clientId": f"client-{n}"}}).encode()
                            conn.sendall(struct.pack("<I", len(reply)) + reply)
                        else:
                            heard.append(message)
        threading.Thread(target=app, daemon=True).start()

        self.chat("archive", "--thread", thread)
        self.chat("unarchive", "--thread", thread)

        base = {"type": "broadcast", "params": {"hostId": "local", "conversationId": thread}}
        self.assertEqual(heard, [dict(base, method="thread-archived", sourceClientId="client-1", version=2),
                                 dict(base, method="thread-unarchived", sourceClientId="client-2", version=1)])

    def test_git_ignores_rooms(self):
        self.open_room()
        status = subprocess.run(["git", "-C", self.repo, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(status, "")


class ReviewTests(Base):
    """`tandem review`: a read-only Codex thread reads a change and answers with findings; the user posts them."""

    def setUp(self):
        super().setUp()
        path = os.path.join(self.bin, "gh")
        with open(path, "w") as f:
            f.write(FAKE_GH)
        os.chmod(path, 0o755)
        self.commit_initial()
        self.base = self.git("symbolic-ref", "--short", "HEAD")
        self.env["FAKE_GH_BASE"] = self.base

    def git(self, *argv):
        return subprocess.run(["git", "-C", self.repo, *argv], env=self.env, check=True, capture_output=True,
                              text=True).stdout.strip()

    def make_pull_request(self):
        """Pull request #7 on a local `origin`: branch greeting adds greet.py."""
        origin = os.path.join(self.tmp, "origin.git")
        subprocess.run(["git", "clone", "-q", "--bare", self.repo, origin], env=self.env, check=True)
        self.git("remote", "add", "origin", origin)
        self.git("checkout", "-q", "-b", "greeting")
        with open(os.path.join(self.repo, "greet.py"), "w") as f:
            f.write("name = input()\nprint('hi', name)\n")
        self.git("add", "greet.py")
        self.git("commit", "-q", "-m", "Add the greeting")
        self.git("push", "-q", "origin", "greeting:refs/pull/7/head")
        head = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", self.base)
        return head

    def test_a_pull_request_is_reviewed_read_only_in_its_own_worktree(self):
        head = self.make_pull_request()
        started = json.loads(self.chat("review", "--target", "7", "--json").stdout)
        self.assertEqual((started["room"], started["sent"], started["review"]["kind"]), ("review-pr-7", 1, "pr"))
        worktree = os.path.join(self.repo, ".tandem", "worktrees", "review-pr-7")
        self.assertEqual(subprocess.run(["git", "-C", worktree, "rev-parse", "HEAD"], capture_output=True,
                                        text=True).stdout.strip(), head)
        self.wait_for_turn("review-pr-7", 1)

        calls = self.server_calls()
        start = next(c["params"] for c in calls if c.get("method") == "thread/start")
        self.assertEqual((start["cwd"], start["sandbox"]), (self.repo, "read-only"))
        self.assertEqual(next(c["params"]["name"] for c in calls if c.get("method") == "thread/name/set"),
                         "repo · Review PR #7 “Add the greeting”")
        turn = next(c["params"] for c in calls if c.get("method") == "turn/start")
        self.assertEqual(turn["effort"], "high")
        self.assertIn("findings", json.dumps(turn["outputSchema"]))
        message = turn["input"][0]["text"]
        merge_base = self.git("merge-base", self.base, head)
        for part in ("Change nothing", f"Its code is checked out at {worktree}", f"diff {merge_base}",
                     "CI checks: 1 passed, 1 failed (lint)", "Greets the user.", "- fit:", "- tests:", "AGENTS.md, CLAUDE.md"):
            self.assertIn(part, message)

        polled = self.poll("review-pr-7")
        answer = polled["events"][0]["text"]
        self.assertTrue(answer.startswith("Codex reviewed PR #7 “Add the greeting”: 2 findings; it calls the change incorrect."))
        self.assertLess(answer.index("[P1 · bug] Handle an empty name"), answer.index("[P2 · fit] Use the existing say helper"))
        self.assertIn("greet.py:1-2 · confidence 0.7", answer)
        findings = polled["review"]["result"]["findings"]
        self.assertEqual([(f["id"], f["priority"]) for f in findings], [(1, 1), (2, 2)])
        self.assertEqual(polled["review"]["pr"]["head_sha"], head)

        # The user posts the first finding: one review on the pull request, with a comment on its line.
        posted = json.loads(self.chat("review-post", "--room", "review-pr-7", "--items", "1", "--json").stdout)
        self.assertEqual((posted["posted"], posted["inline"]), (1, True))
        with open(os.path.join(self.tmp, "gh-reviews.jsonl")) as f:
            sent = json.loads(f.readline())
        self.assertEqual(sent["args"][:4], ["api", "--method", "POST", "repos/acme/app/pulls/7/reviews"])
        self.assertEqual((sent["payload"]["commit_id"], sent["payload"]["event"]), (head, "COMMENT"))
        self.assertEqual([(c["path"], c["line"], c["side"]) for c in sent["payload"]["comments"]], [("greet.py", 1, "RIGHT")])
        self.assertIn("**[P1] Handle an empty name**", sent["payload"]["comments"][0]["body"])

        # Closing the review removes the worktree it read the change in.
        self.chat("close", "--room", "review-pr-7")
        self.assertFalse(os.path.exists(worktree))

    def test_a_line_github_cannot_comment_on_sends_the_findings_in_the_review_text(self):
        self.make_pull_request()
        self.chat("review", "--target", "#7")
        self.wait_for_turn("review-pr-7", 1)
        self.poll("review-pr-7")
        self.env["FAKE_GH_NO_INLINE"] = "1"
        posted = json.loads(self.chat("review-post", "--room", "review-pr-7", "--items", "1,2", "--json").stdout)
        self.assertEqual((posted["posted"], posted["inline"]), (2, False))
        with open(os.path.join(self.tmp, "gh-reviews.jsonl")) as f:
            last = json.loads(f.read().splitlines()[-1])["payload"]
        self.assertNotIn("comments", last)
        self.assertIn("**[P2] Use the existing say helper**", last["body"])
        self.assertIn("`greet.py:1`", last["body"])

    def test_uncommitted_changes_are_reviewed_in_the_checkout_and_a_branch_against_its_base(self):
        self.assertIn("no uncommitted changes", self.chat("review", ok=False).stderr)
        with open(os.path.join(self.repo, "README.md"), "a") as f:
            f.write("more\n")
        started = json.loads(self.chat("review", "--json", "--focus", "the wording").stdout)
        self.assertEqual(started["room"], "review-changes")
        self.wait_for_turn("review-changes", 1)
        message = next(c["params"] for c in self.server_calls() if c.get("method") == "turn/start")["input"][0]["text"]
        self.assertIn(f"The uncommitted changes in {self.repo}", message)
        self.assertIn("look especially at: the wording", message)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".tandem", "worktrees")))

        self.git("checkout", "-q", "-b", "feature")
        self.git("commit", "-q", "-am", "More readme")
        self.git("checkout", "-q", self.base)
        started = json.loads(self.chat("review", "--target", "feature", "--json").stdout)
        self.assertEqual((started["room"], started["review"]["kind"], started["review"]["base"]), ("review-feature", "branch", self.base))

    def test_a_target_or_base_that_reads_as_an_option_is_refused(self):
        self.make_pull_request()  # an origin on disk, where git runs an --upload-pack command
        marker = os.path.join(self.tmp, "pwned")
        result = self.chat("review", f"--target=--upload-pack=touch {marker}; git-upload-pack", ok=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not a pull request, branch or commit", result.stderr)
        self.assertFalse(os.path.exists(marker))
        self.assertIn("--base", self.chat("review", "--target", "greeting", "--base=--no-such", ok=False).stderr)
        self.git("branch", "keep")
        refspec = self.chat("review", "--target", "+refs/heads/greeting:refs/heads/keep", ok=False)
        self.assertIn("not a pull request, branch or commit", refspec.stderr)
        self.assertEqual(self.git("rev-parse", "keep"), self.git("rev-parse", self.base))

    def test_a_pull_request_of_another_repository_is_refused(self):
        self.make_pull_request()
        refused = self.chat("review", "--target", "https://github.com/someone/else/pull/7", ok=False)
        self.assertIn("someone/else", refused.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".tandem", "worktrees", "review-pr-7")))

    def test_a_second_review_waits_and_leaves_the_running_ones_code_alone(self):
        head = self.make_pull_request()
        self.chat("review", "--target", "7")
        self.wait_for_turn("review-pr-7", 1)
        self.git("checkout", "-q", "greeting")
        with open(os.path.join(self.repo, "greet.py"), "a") as f:
            f.write("print('bye')\n")
        self.git("commit", "-q", "-am", "More")
        self.git("push", "-q", "origin", "greeting:refs/pull/7/head")
        self.git("checkout", "-q", self.base)
        with open(os.path.join(self.repo, ".tandem", "review-pr-7", "turn.lock"), "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)  # Codex is still reviewing
            busy = self.chat("review", "--target", "7", ok=False)
        self.assertEqual(busy.returncode, 4)
        worktree = os.path.join(self.repo, ".tandem", "worktrees", "review-pr-7")
        self.assertEqual(subprocess.run(["git", "-C", worktree, "rev-parse", "HEAD"], capture_output=True,
                                        text=True).stdout.strip(), head)

    def test_findings_in_a_loose_shape_never_stop_the_listener(self):
        sys.path.insert(0, os.path.join(ROOT, "codex-skills", "tandem", "scripts"))
        import tandem_core
        room = tandem_core.Room(argparse.Namespace(room="r", cd=self.repo))
        os.makedirs(room.dir)
        text = tandem_core.review_answer(room, {}, 1, json.dumps({"findings": [
            {"title": "a", "confidence": "high", "priority": "1"}, {"title": "b", "confidence": [1]}]}))
        self.assertIn("2 findings", text)

    def test_follow_up_messages_in_a_review_stay_read_only_and_answer_as_text(self):
        self.make_pull_request()
        self.chat("review", "--target", "7")
        self.wait_for_turn("review-pr-7", 1)
        self.poll("review-pr-7")
        sent = self.chat("send", "--room", "review-pr-7", "--from", "claude", "--message", "Is finding 2 real?")
        self.wait_for_turn("review-pr-7", int(sent.stdout.split()[0].lstrip("#")))
        later = [c["params"] for c in self.server_calls() if c.get("method") in ("thread/resume", "turn/start")]
        self.assertEqual(later[-2]["sandbox"], "read-only")  # the resume keeps the thread read-only
        self.assertNotIn("outputSchema", later[-1])
        self.assertTrue(self.poll("review-pr-7")["events"][0]["text"].startswith("ANSWER:"))


class SpawnTests(Base):
    def read(self, name):
        with open(os.path.join(self.tmp, name)) as f:
            return f.read()

    def test_claude_joins_the_room_codex_opened(self):
        self.chat("open", "--room", "from-codex", "--codex-thread", THREAD)
        self.chat("send", "--room", "from-codex", "--from", "codex", "--message", "Hello Claude")
        joined = json.loads(self.chat("open", "--room", "claude-side", "--join", "--codex-thread", THREAD, "--json").stdout)
        self.assertEqual(joined["room"], "from-codex")
        self.assertEqual([e["text"] for e in self.poll("from-codex")["events"]], ["Hello Claude"])
        self.chat("close", "--room", "from-codex")
        fresh = json.loads(self.chat("open", "--room", "claude-side", "--join", "--codex-thread", THREAD, "--json").stdout)
        self.assertEqual(fresh["room"], "claude-side")

    def test_new_codex_runs_first_message_in_background(self):
        self.commit_initial()
        started = json.loads(self.chat("new-codex", "--room", "n", "--json", "--worktree", "--effort", "medium",
                                       "--message", "Hello Codex").stdout)
        self.assertEqual((started["thread"], started["sent"]), (NEW_THREAD, 1))
        self.wait_for_turn("n", 1)
        calls = self.server_calls()
        self.assertIn('shell_environment_policy.set.TANDEM_SPAWNED="1"', calls[0]["argv"])
        start = next(c["params"] for c in calls if c.get("method") == "thread/start")
        self.assertEqual((start["cwd"], start["approvalPolicy"]), (self.repo, "never"))
        self.assertEqual(next(c["params"]["name"] for c in calls if c.get("method") == "thread/name/set"), "repo · Hello Codex")
        turn = next(c["params"] for c in calls if c.get("method") == "turn/start")
        self.assertEqual(turn["effort"], "medium")
        self.assertNotIn("cwd", turn)
        self.assertIn(f"Your working folder is {os.path.join(self.repo, '.tandem', 'worktrees', 'n')}", turn["input"][0]["text"])
        self.assertEqual(next(c["params"]["gitInfo"]["branch"] for c in calls if c.get("method") == "thread/metadata/update"),
                         "tandem/n")
        self.assertIn("Claude started this Codex thread", turn["input"][0]["text"])
        self.assertEqual(self.poll("n")["events"], [{"type": "answer", "numbers": [1], "text": "ANSWER: Hello Codex"}])
        branches = subprocess.run(["git", "-C", self.repo, "branch", "--list", "tandem/n"], capture_output=True, text=True)
        self.assertIn("tandem/n", branches.stdout)
        # Later messages name the worktree too, so it holds after Codex compacts the thread.
        sent = self.chat("send", "--room", "n", "--from", "claude", "--message", "Next step")
        self.wait_for_turn("n", int(sent.stdout.split()[0].lstrip("#")))  # #3: Codex's answer was #2
        later = [c["params"] for c in self.server_calls() if c.get("method") == "turn/start"][1]
        self.assertIn("Your working folder is", later["input"][0]["text"])

    def test_background_turn_when_no_app_has_the_thread(self):
        self.chat("open", "--room", "b", "--codex-thread", THREAD)
        sent = self.chat("send", "--room", "b", "--from", "claude", "--message", "Are you there?")
        self.assertIn("in the background", sent.stdout)
        self.wait_for_turn("b", 1)
        self.assertEqual(self.poll("b")["events"], [{"type": "answer", "numbers": [1], "text": "ANSWER: Are you there?"}])
        self.assertEqual(self.queued(), [])

    def test_background_turn_waits_for_a_busy_one_turn_run(self):
        locks = os.path.join(self.codex_home, "thread-writer-locks")
        os.makedirs(locks, exist_ok=True)
        ready = os.path.join(self.codex_home, "busy-ready")
        busy = subprocess.Popen([sys.executable, "-c",
                                 "import sys, time; f = open(sys.argv[1], 'w'); open(sys.argv[2], 'w').close(); time.sleep(3)",
                                 os.path.join(locks, THREAD + ".lock"), ready, "exec"])
        self.addCleanup(busy.wait)
        deadline = time.time() + 10
        while not os.path.exists(ready) and time.time() < deadline:
            time.sleep(0.05)
        started = time.time()
        self.chat("open", "--room", "w", "--codex-thread", THREAD)
        sent = self.chat("send", "--room", "w", "--from", "claude", "--message", "after you")
        self.assertIn("in the background", sent.stdout)
        self.wait_for_turn("w", 1)
        self.assertGreater(time.time() - started, 2)
        events = self.poll("w")["events"]
        if not events:
            self.fail(self.room_state("w", 1))
        self.assertEqual(events[0]["text"], "ANSWER: after you")

    def test_an_app_among_several_holders_takes_the_message(self):
        locks = os.path.join(self.codex_home, "thread-writer-locks")
        os.makedirs(locks, exist_ok=True)
        ready = [os.path.join(self.codex_home, f"ready-{i}") for i in range(2)]
        for flag, tag in zip(ready, ["exec", "/Applications/ChatGPT.app/Contents/Resources/codex"]):
            holder = subprocess.Popen([sys.executable, "-c",
                                       "import sys, time; f = open(sys.argv[1], 'w'); open(sys.argv[2], 'w').close(); time.sleep(30)",
                                       os.path.join(locks, THREAD + ".lock"), flag, tag])
            self.addCleanup(holder.wait)
            self.addCleanup(holder.kill)
        deadline = time.time() + 10
        while not all(map(os.path.exists, ready)) and time.time() < deadline:
            time.sleep(0.05)
        self.chat("open", "--room", "a", "--codex-thread", THREAD)
        sent = self.chat("send", "--room", "a", "--from", "claude", "--message", "for the app")
        self.assertNotIn("in the background", sent.stdout)
        self.assertEqual(len(self.queued()), 1)

    def test_failed_background_turn_is_reported(self):
        self.chat("open", "--room", "f", "--codex-thread", THREAD)
        self.env["FAKE_FAIL"] = "1"
        self.chat("send", "--room", "f", "--from", "claude", "--message", "hello")
        self.wait_for_turn("f", 1)
        events = self.poll("f")["events"]
        self.assertEqual([e["type"] for e in events], ["aborted"])
        self.assertIn("fake failure", events[0]["text"])

    def test_spawned_thread_keeps_agents_from_spawning(self):
        self.chat("new-codex", "--room", "n", "--json", "--message", "first")
        self.wait_for_turn("n", 1)
        self.chat("send", "--room", "n", "--from", "claude", "--message", "second")
        self.wait_for_turn("n", 2)
        servers = [c["argv"] for c in self.server_calls() if "argv" in c]
        self.assertEqual(len(servers), 2)
        self.assertIn('shell_environment_policy.set.TANDEM_SPAWNED="1"', servers[1])
        self.assertIn('shell_environment_policy.set.TANDEM_TURN="1"', servers[1])
        self.assertTrue(any(c.get("method") == "thread/resume" for c in self.server_calls()))

    def test_holder_kinds(self):
        sys.path.insert(0, os.path.join(ROOT, "codex-skills", "tandem", "scripts"))
        import tandem_core
        bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
        kinds = [tandem_core.holder_kind(command) for command in (
            "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
            'codex app-server -c shell_environment_policy.set.TANDEM_TURN="1"',
            "codex exec --json resume x",
            "node codex-companion.mjs app-server-broker",
            "codex",
            f'{bundled} app-server -c shell_environment_policy.set.TANDEM_TURN="1"',  # Tandem's turn on the app's CLI
            f"{bundled} exec --json fork x",
            "codex exec-server")]
        self.assertEqual(kinds, ["Codex app", "Tandem turn", "Codex exec", "Codex plugin in Claude Code", "Codex CLI",
                                 "Tandem turn", "Codex exec", "Codex CLI"])

    def test_only_turns_that_need_no_tandem_settings_go_to_the_app(self):
        sys.path.insert(0, os.path.join(ROOT, "codex-skills", "tandem", "scripts"))
        import tandem_core
        saved = os.environ.pop("TANDEM_NO_APP", None)
        self.addCleanup(lambda: saved is None or os.environ.__setitem__("TANDEM_NO_APP", saved))
        full = {"in_app": True, "sandbox": "danger-full-access"}
        self.assertEqual(tandem_core.app_runs(full), sys.platform == "darwin")
        self.assertEqual(tandem_core.app_runs(dict(full, sandbox=None)), sys.platform == "darwin")
        for spec in (dict(full, sandbox="read-only"), dict(full, sandbox="workspace-write"),
                     dict(full, output_schema={"type": "object"}), dict(full, in_app=False)):
            self.assertFalse(tandem_core.app_runs(spec), spec)

    def test_threads_tandem_started_do_not_spawn_from_the_codex_app(self):
        self.chat("new-codex", "--room", "n", "--json", "--message", "first")
        self.wait_for_turn("n", 1)
        self.env["CODEX_THREAD_ID"] = NEW_THREAD  # a turn the Codex app runs has no TANDEM_SPAWNED, only its thread
        self.assertEqual(self.chat("new-codex", "--room", "m", "--message", "x", ok=False).returncode, 4)
        self.assertEqual(self.chat("new-claude", "--room", "c", ok=False).returncode, 4)

    def test_ask_thread_fork_has_no_plugins_or_apps(self):
        self.chat("ask-thread", "--thread", THREAD, "--message", "What did you change?", ok=False)
        argv = self.read("codex-exec-argv.txt").split("\n=====\n")[0].splitlines()
        for setting in ('sandbox_mode="read-only"', "features.plugins=false", "features.apps=false"):
            self.assertIn(setting, argv)
        self.assertIn("fork", argv)

    def test_ask_thread_sends_the_question_on_stdin(self):
        question = "-v\n- is the cache safe?"  # read as options if it came on the command line
        answer = self.chat("ask-thread", "--thread", THREAD, "--message", question)
        self.assertEqual(self.read("codex-exec-argv.txt").split("\n=====\n")[0].splitlines()[-1], "-")
        self.assertEqual(self.read("codex-exec-prompt.txt"), question)
        self.assertIn("ANSWER", answer.stdout)

    def test_ask_thread_switches_off_every_mcp_server_it_finds(self):
        with open(os.path.join(self.codex_home, "config.toml"), "w") as f:
            f.write('[mcp_servers."figma-desktop"]\ncommand = "x"\n[apps.github]\nenabled = true\n')
        os.makedirs(os.path.join(self.repo, ".codex"))
        with open(os.path.join(self.repo, ".codex", "config.toml"), "w") as f:
            f.write("[mcp_servers.local_db]\ncommand = 'y'\n")
        self.chat("ask-thread", "--thread", THREAD, "--message", "What did you change?")
        argv = self.read("codex-exec-argv.txt").split("\n=====\n")[0].splitlines()
        for setting in ("mcp_servers.figma-desktop.enabled=false", "apps.github.enabled=false", "mcp_servers.local_db.enabled=false"):
            self.assertIn(setting, argv)

    def test_a_room_keeps_its_thread(self):
        self.chat("open", "--room", "r", "--codex-thread", THREAD)
        other = os.path.join(self.codex_home, "sessions", "2026", "10", "25", f"rollout-2026-10-25T10-00-01-{NEW_THREAD}.jsonl")
        with open(other, "w") as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": NEW_THREAD, "cwd": self.repo}}) + "\n")
        refused = self.chat("open", "--room", "r", "--codex-thread", NEW_THREAD, ok=False)
        self.assertIn("another Codex thread", refused.stderr)

    def test_a_sandboxed_thread_open_in_an_app_is_not_handed_to_it(self):
        self.app_holds(THREAD)
        self.chat("open", "--room", "s", "--codex-thread", THREAD)
        meta_path = os.path.join(self.repo, ".tandem", "s", "room.json")
        with open(meta_path) as f:
            meta = json.load(f)
        with open(meta_path, "w") as f:
            json.dump(dict(meta, sandbox="read-only", spawned=True), f)
        refused = self.chat("send", "--room", "s", "--from", "claude", "--message", "Is it safe?", ok=False)
        self.assertEqual(refused.returncode, 5)
        self.assertIn("read-only", refused.stderr)
        self.assertEqual(self.queued(), [])

    def test_messages_to_a_busy_room_run_in_order(self):
        self.chat("open", "--room", "o", "--codex-thread", THREAD)
        turns = os.path.join(self.repo, ".tandem", "o", "turns")
        os.makedirs(turns)
        earlier = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)", "run-turn"])  # #1's runner, on its turn
        self.addCleanup(earlier.wait)
        with open(os.path.join(turns, "1.pid"), "w") as f:
            f.write(str(earlier.pid))
        with open(os.path.join(self.repo, ".tandem", "o", "seq"), "w") as f:
            f.write("1")
        started = time.time()
        self.chat("send", "--room", "o", "--from", "claude", "--message", "second")
        self.wait_for_turn("o", 2)
        self.assertGreater(time.time() - started, 1.5)

    def test_new_claude_starts_background_session(self):
        self.env["CODEX_THREAD_ID"] = THREAD
        result = self.chat("new-claude", "--room", "c", "--message", "Hi Claude, review the plan")
        self.assertIn("abc12345", result.stdout)
        argv = self.read("claude-bg-argv.txt")
        self.assertIn(THREAD, argv)
        self.assertIn("mcp__tandem__connect,mcp__tandem__send", argv.splitlines())
        env = self.read("claude-bg-env.txt").splitlines()
        self.assertIn("TANDEM_SPAWNED=1", env)
        self.assertFalse([line for line in env if line.startswith("CODEX_THREAD_ID=")])
        self.assertIn("Hi Claude, review the plan", self.chat("log", "--room", "c").stdout)

    def test_spawned_agents_do_not_spawn(self):
        self.env["TANDEM_SPAWNED"] = "1"
        self.assertEqual(self.chat("new-codex", "--room", "n", "--message", "x", ok=False).returncode, 4)
        self.env["CODEX_THREAD_ID"] = THREAD
        self.assertEqual(self.chat("new-claude", "--room", "c", ok=False).returncode, 4)

    def test_new_claude_refuses_inside_claude_and_without_plugin(self):
        self.env["CODEX_THREAD_ID"] = THREAD
        self.env["CLAUDECODE"] = "1"
        self.assertEqual(self.chat("new-claude", "--room", "c", ok=False).returncode, 4)
        del self.env["CLAUDECODE"]
        self.env["FAKE_NO_TANDEM"] = "1"
        result = self.chat("new-claude", "--room", "c", ok=False)
        self.assertEqual(result.returncode, 3)
        self.assertIn("not enabled", result.stderr)


class AskClaudeTests(Base):
    def ask(self, *args, ok=True):
        env = dict(self.env, PATH=f"{self.bin}:/usr/bin:/bin")
        result = subprocess.run(["/bin/bash", ASK_CLAUDE, "--cd", self.repo, *args], env=env,
                                capture_output=True, text=True, timeout=60)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def argv(self):
        with open(os.path.join(self.tmp, "claude-argv.txt")) as f:
            return f.read().splitlines()

    def test_long_prompt_is_fast(self):
        started = time.time()
        self.ask("--prompt", "lorem ipsum dolor sit amet " * 2500)
        self.assertLess(time.time() - started, 10)

    def test_session_must_be_uuid(self):
        self.assertEqual(self.ask("--prompt", "hi", "--session", "--dangerously-skip-permissions", ok=False).returncode, 2)
        self.ask("--prompt", "hi", "--session", SESSION)
        self.assertIn("--resume", self.argv())

    def test_title_cut_by_characters(self):
        self.ask("--prompt", "čćšžđ " * 30)
        title = self.argv()[self.argv().index("--name") + 1]
        title.encode("utf-8")
        self.assertLessEqual(len(title), len("Codex → Claude: ") + 60)
        self.assertNotIn("�", title)

    def test_consult_mode_is_read_only(self):
        self.ask("--prompt", "hi")
        argv = self.argv()
        denied = argv[argv.index("--disallowedTools") + 1: argv.index("--append-system-prompt")]
        for tool in ("Edit", "Write", "WebFetch", "WebSearch", "Read(~/.ssh/**)"):
            self.assertIn(tool, denied)
        allowed = argv[argv.index("--allowedTools") + 1: argv.index("--disallowedTools")]
        self.assertFalse([a for a in allowed if a.startswith("Bash(git diff") or a.startswith("Bash(git log")])

    def test_edit_mode_has_no_blanket_edit_rule(self):
        self.ask("--prompt", "hi", "--mode", "edit")
        argv = self.argv()
        allowed = argv[argv.index("--allowedTools") + 1: argv.index("--disallowedTools")]
        self.assertNotIn("Edit", allowed)
        self.assertNotIn("Write", allowed)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "acceptEdits")

    def test_web_flag(self):
        self.ask("--prompt", "hi", "--web")
        argv = self.argv()
        allowed = argv[argv.index("--allowedTools") + 1: argv.index("--disallowedTools")]
        self.assertIn("WebFetch", allowed)


if __name__ == "__main__":
    unittest.main()
