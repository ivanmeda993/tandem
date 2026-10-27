"""Tests for the Tandem orchestrator with a fake `codex`: plan, approval, workers, digest, review, merge.

Run from the repository root: python3 -m unittest discover -s tests -v
"""

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from test_core import AGENT_CHAT, ROOT, THREAD, Base


FULL_ACCESS_RUN = {"setup": {"workers": {"access": "full"}}}


def task(task_id, **extra):
    return dict({"id": task_id, "title": f"Task {task_id}", "role": "implementer",
                 "brief": f"WRITE {task_id}.txt hello from {task_id}"}, **extra)


class OrchHelpers:
    def orch(self, *args, ok=True, stdin=None):
        result = subprocess.run([AGENT_CHAT, "orch", *args, "--cd", self.repo], env=self.env, capture_output=True,
                                text=True, input=stdin, timeout=60)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def start(self, **setup):
        setup.setdefault("simplify", False)
        setup.setdefault("auto_merge", False)  # most tests merge by hand, as the user's click
        return json.loads(self.orch("init", "--goal", "Say hello", "--setup", json.dumps(setup)).stdout)["run"]["id"]

    def plan(self, run, tasks, ok=True):
        return self.orch("plan", "--run", run, stdin=json.dumps({"tasks": tasks}), ok=ok)

    def act(self, verb, run, *args, ok=True):
        return json.loads(self.orch(verb, "--run", run, *args, ok=ok).stdout)

    def poll_until(self, run, check, timeout=20):
        events, deadline = [], time.time() + timeout
        while time.time() < deadline:
            out = json.loads(self.orch("poll", "--run", run).stdout)
            events += out["events"]
            if check(out["run"], events):
                return out["run"], events
            time.sleep(0.2)
        self.fail(f"timed out: {json.dumps(out['run'])[:1500]}")

    def status(self, view, task_id):
        return next(t["status"] for t in view["tasks"] if t["id"] == task_id)

    def git(self, *args):
        return subprocess.run(["git", "-C", self.repo, *args], capture_output=True, text=True, env=self.env).stdout.strip()

    def branch(self, run, task_id=None):
        """The run's branch, where merged work collects, or a task's own branch."""
        data = self.run_json(run)
        return data["integration"]["branch"] if task_id is None else next(t["branch"] for t in data["tasks"] if t["id"] == task_id)

    def worktree(self, run, place):
        """A task's worktree, or the run's own ("result"), named like its branch."""
        return os.path.join(self.repo, ".tandem", "worktrees", self.run_json(run)["name"], place)

    def run_json(self, run):
        with open(os.path.join(self.repo, ".tandem", "runs", run, "run.json")) as f:
            return json.load(f)

    def slow_codex(self, seconds):
        """The fake codex's app server waits before it answers, so a worker stays running for a while."""
        real = os.path.join(self.bin, "codex-real")
        os.rename(os.path.join(self.bin, "codex"), real)
        with open(os.path.join(self.bin, "codex"), "w") as f:
            f.write(f'#!/bin/sh\nif [ "$1" = app-server ]; then sleep {seconds}; fi\nexec "{real}" "$@"\n')
        os.chmod(os.path.join(self.bin, "codex"), 0o755)

    def fake_app(self, seconds):
        """Stands for macOS `open`: the "Codex app" takes the thread's writer lock for a while."""
        opener = os.path.join(self.bin, "open")
        with open(opener, "w") as f:
            f.write('#!/bin/sh\nid="${2##*/}"; mkdir -p "$CODEX_HOME/thread-writer-locks"\n'
                    f'python3 -c "import sys, time; f = open(sys.argv[1], \'w\'); time.sleep({seconds})" '
                    '"$CODEX_HOME/thread-writer-locks/$id.lock" /Applications/ChatGPT.app/fake >/dev/null 2>&1 &\n')
        os.chmod(opener, 0o755)
        self.env.pop("TANDEM_NO_APP")
        self.env["TANDEM_OPENER"] = opener

    def runner_running(self, pid):
        return "run-turn" in subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout



class OrchTests(OrchHelpers, Base):
    def setUp(self):
        super().setUp()
        self.commit_initial()

    def test_plan_to_merged_branch(self):
        run = self.start()
        self.plan(run, [task("a"), task("b", deps=["a"])])
        self.assertTrue(json.loads(self.orch("status", "--run", run, "--json").stdout)["run"]["needs_approval"])
        approved = self.act("approve", run)
        self.assertIn("Workers started: a", approved["text"])
        self.assertEqual(self.status(approved["run"], "b"), "pending")

        view, events = self.poll_until(run, lambda v, e: any(x["type"] == "digest" for x in e))
        self.assertEqual(self.status(view, "a"), "reported")
        digest = next(x["text"] for x in events if x["type"] == "digest")
        self.assertIn("a · Task a · implementer · reported · 1 file changed", digest)
        self.assertIn("orch_review", digest)
        self.assertIn("hello from a", self.orch("diff", "--run", run, "--task", "a").stdout)

        calls = self.server_calls()
        start = next(c["params"] for c in calls if c.get("method") == "thread/start")
        self.assertEqual((start["sandbox"], start["approvalPolicy"], start["cwd"]), ("danger-full-access", "never", self.repo))
        self.assertIn("features.multi_agent=false", calls[0]["argv"])
        turn = next(c["params"] for c in calls if c.get("method") == "turn/start")
        self.assertEqual(turn["effort"], "high")
        self.assertNotIn("cwd", turn)  # a turn's own folder would move the thread out of the project in the Codex app
        self.assertIn(f"Your working folder is {self.worktree(run, 'a')}", turn["input"][0]["text"])
        branch = next(c["params"]["gitInfo"]["branch"] for c in calls if c.get("method") == "thread/metadata/update")
        self.assertEqual(branch, self.branch(run, "a"))
        self.assertEqual(next(c["params"]["name"] for c in calls if c.get("method") == "thread/name/set"), "repo · Task a")

        self.assertEqual(self.status(self.act("review", run, "--task", "a", "--verdict", "approve")["run"], "a"), "approved")
        self.assertIn("Merged a", self.act("merge", run, "--task", "a")["text"])
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.act("review", run, "--task", "b", "--verdict", "approve")
        self.act("merge", run, "--task", "b")
        view, events = self.poll_until(run, lambda v, e: any(x["type"] == "done" for x in e))
        self.assertEqual(view["status"], "done")
        self.assertEqual(self.git("show", f"{self.branch(run)}:a.txt"), "hello from a")
        self.assertEqual(self.git("show", f"{self.branch(run)}:b.txt"), "hello from b")
        self.assertIn("Tandem-Task: a", self.git("log", "--format=%B", self.branch(run)))
        self.assertEqual(view["codex_quota"], 12)

        cleaned = self.act("cleanup", run)
        self.assertIn("integration", cleaned["text"])
        self.assertFalse(os.path.exists(self.worktree(run, "a")))
        self.assertFalse(os.path.exists(os.path.dirname(self.worktree(run, "a"))))  # the run's folder of worktrees too
        self.assertEqual(self.git("branch", "--list", self.branch(run)), self.branch(run))
        with open(os.path.join(self.tmp, "archived.txt")) as f:  # the workers' threads leave the Codex app's list
            self.assertEqual(sorted(f.read().split()), sorted(t["thread"] for t in view["tasks"]))

    def test_simplifier_proposes_and_the_builder_applies_the_users_pick(self):
        run = self.start(simplify=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        approved = self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn("proposes simplifications", approved["text"])
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "proposals")
        self.assertEqual([p["id"] for p in next(t["proposals"] for t in view["tasks"])], [1, 2])
        calls = self.server_calls()
        starts = [c["params"] for c in calls if c.get("method") == "thread/start"]
        self.assertEqual((starts[1]["sandbox"], starts[1]["cwd"]), ("read-only", starts[0]["cwd"]))
        simplifier = [c["params"] for c in calls if c.get("method") == "turn/start"][1]
        self.assertIn("outputSchema", simplifier)
        self.assertNotIn("## Report", simplifier["input"][0]["text"])  # it answers in the schema's JSON only
        names = [c["params"]["name"] for c in calls if c.get("method") == "thread/name/set"]
        self.assertEqual(names, ["repo · Task a", "repo · Simplify · Task a"])

        applied = self.act("apply", run, "--task", "a", "--items", "2")
        self.assertIn("picked 1", applied["text"])
        shown = next(t for t in applied["run"]["tasks"] if t["id"] == "a")  # the proposals stay in view after the pick
        self.assertEqual(([p["id"] for p in shown["proposals"]], shown["applied"]), ([1, 2], [2]))
        self.poll_until(run, lambda v, e: any(x["type"] == "digest" and "applied the simplifications" in x["text"] for x in e))
        resumed = [c["params"]["threadId"] for c in self.server_calls() if c.get("method") == "thread/resume"]
        self.assertEqual(resumed, ["01a17000-0000-7000-8000-000000000099"])
        diff = self.orch("diff", "--run", run, "--task", "a").stdout
        self.assertIn("simpler", diff)
        self.assertNotIn("gone", diff)
        self.assertEqual(self.status(self.act("review", run, "--task", "a", "--verdict", "approve")["run"], "a"), "approved")

    def test_skipping_the_proposals_makes_the_task_ready(self):
        run = self.start(simplify=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.poll_until(run, lambda v, e: self.status(v, "a") == "proposals")
        self.assertEqual(self.status(self.act("apply", run, "--task", "a")["run"], "a"), "approved")

    def test_the_journal_hands_back_the_run_and_the_notes_and_cleanup_removes_the_notes(self):
        run = self.start()
        self.plan(run, [task("a"), task("b", deps=["a"])])
        self.act("approve", run)
        self.orch("note", "--run", run, "--text", "The user wants the  tokens\nin src/theme.")
        self.assertEqual(self.orch("note", "--run", run, "--text", "x" * 700, ok=False).returncode, 2)

        journal = self.orch("journal", "--run", run).stdout
        self.assertIn(f"Run {run} in {self.repo}: running", journal)
        self.assertIn("Goal: Say hello", journal)
        self.assertIn(f"Branch: {self.branch(run)}, where merged work collects: 0 of 2 tasks finished.", journal)
        self.assertIn("- b · Task b · implementer · waits for a", journal)
        self.assertIn("approve:", journal)  # the run's latest events
        self.assertRegex(journal, r"- \d{4}-\d\d-\d\d \d\d:\d\d · The user wants the tokens in src/theme\.")

        self.act("stop", run)
        self.act("cleanup", run)
        self.assertIn("Your notes (orch_note):\n(none yet)", self.orch("journal", "--run", run).stdout)

    def test_diffs_leave_the_workers_index_alone_and_skip_build_leftovers(self):
        run = self.start()
        self.plan(run, [task("a", brief="WRITE a.txt real work\nWRITE stale.pyc leftover")])
        self.act("approve", run)
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.assertIn("1 file changed", next(t["diffstat"] for t in view["tasks"]))
        # The panel's summary of the task: the files it changed, without build leftovers, and what its worker reported.
        reported = view["tasks"][0]
        self.assertEqual(reported["files"], [{"path": "a.txt", "added": 1, "removed": 0}])
        self.assertTrue(reported["report"].startswith("ANSWER:"))
        approved = self.act("review", run, "--task", "a", "--verdict", "approve", "--notes", "Reads well.")["run"]["tasks"][0]
        self.assertEqual(approved["review"], "Reads well.")
        diff = self.orch("diff", "--run", run, "--task", "a").stdout
        self.assertIn("a.txt", diff)
        self.assertNotIn("stale.pyc", diff)
        worktree = self.worktree(run, "a")
        staged = subprocess.run(["git", "-C", worktree, "diff", "--cached", "--name-only"], capture_output=True, text=True)
        self.assertEqual(staged.stdout.strip(), "")
        self.act("merge", run, "--task", "a")
        self.assertEqual(self.git("ls-tree", "--name-only", self.branch(run)).split(), ["README.md", "a.txt"])

    def test_changes_then_blocked_then_accepted(self):
        run = self.start(fix_rounds=1)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        sent = self.act("review", run, "--task", "a", "--verdict", "changes", "--notes", "WRITE a.txt better")
        self.assertIn("Sent the changes", sent["text"])
        view, events = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.assertTrue(any(c.get("method") == "thread/resume" for c in self.server_calls()))
        self.assertIn("better", self.orch("diff", "--run", run, "--task", "a").stdout)
        blocked = self.act("review", run, "--task", "a", "--verdict", "changes", "--notes", "more")
        self.assertEqual(self.status(blocked["run"], "a"), "blocked")
        self.assertEqual(self.status(self.act("accept", run, "--task", "a")["run"], "a"), "approved")

    def test_approved_tasks_merge_on_their_own_by_default(self):
        started = json.loads(self.orch("init", "--goal", "Say hello", "--setup", json.dumps({"simplify": False})).stdout)
        run = started["run"]["id"]
        self.assertTrue(started["run"]["auto_merge"])
        self.plan(run, [task("a"), task("b", deps=["a"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        approved = self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn(f"Merged a into {self.branch(run)}", approved["text"])
        self.assertEqual(self.status(approved["run"], "a"), "merged")
        self.assertEqual(self.status(approved["run"], "b"), "running")  # what waited for a starts at once
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.act("review", run, "--task", "b", "--verdict", "approve")
        view, events = self.poll_until(run, lambda v, e: any(x["type"] == "done" for x in e))
        self.assertEqual(self.git("show", f"{self.branch(run)}:b.txt"), "hello from b")
        self.assertEqual([t.get("merged_by") for t in self.run_json(run)["tasks"]], ["tandem", "tandem"])

    def test_auto_merge_after_the_simplifier_and_on_a_conflict(self):
        run = self.start(simplify=True, auto_merge=True)
        self.plan(run, [task("a", brief="WRITE same.txt from a", owns=["one"]),
                        task("b", brief="WRITE same.txt from b", owns=["two"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.poll_until(run, lambda v, e: self.status(v, "a") == "proposals" and self.status(v, "b") == "proposals")
        skipped = self.act("apply", run, "--task", "a")  # the user's pick still comes first
        self.assertIn("Merged a", skipped["text"])
        conflict = self.act("apply", run, "--task", "b")
        self.assertEqual(self.status(conflict["run"], "b"), "conflict")
        self.act("review", run, "--task", "b", "--verdict", "changes", "--notes", "WRITE same.txt resolved")
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.assertIn("Merged b", self.act("review", run, "--task", "b", "--verdict", "approve")["text"])
        self.assertEqual(self.git("show", f"{self.branch(run)}:same.txt"), "resolved")

    def test_a_task_tandem_could_not_merge_waits_for_the_user(self):
        run = self.start(auto_merge=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        integration = self.worktree(run, "result")
        with open(os.path.join(integration, "a.txt"), "w") as f:  # an untracked file the merge would overwrite
            f.write("local\n")
        approved = self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn("Could not merge a", approved["text"])
        self.assertIn("waits for the user's Merge", approved["text"])
        view = json.loads(self.orch("poll", "--run", run).stdout)["run"]  # a poll does not try again
        self.assertEqual(self.status(view, "a"), "approved")
        self.assertIn("Could not merge a", next(t["error"] for t in view["tasks"]))
        os.remove(os.path.join(integration, "a.txt"))
        self.assertIn("Merged a", self.act("merge", run, "--task", "a")["text"])
        self.assertEqual(self.run_json(run)["tasks"][0]["merged_by"], "user")

    def test_branches_and_worktrees_are_named_for_the_goal(self):
        goal = "Dodaj tamnu temu: boje, ikonice i đački režim"
        started = json.loads(self.orch("init", "--goal", goal, "--setup", json.dumps({"simplify": False})).stdout)
        run = started["run"]["id"]
        self.assertEqual(started["run"]["branch"], "tandem/dodaj-tamnu-temu-boje-ikonice-i-djacki/result")
        self.assertEqual(started["run"]["task_branch"], "tandem/dodaj-tamnu-temu-boje-ikonice-i-djacki/<task>")
        self.assertIn("Workers branch off tandem/dodaj-tamnu-temu-boje-ikonice-i-djacki/result", started["text"])
        self.assertIn("task id 'result'", self.plan(run, [task("result")], ok=False).stderr)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.assertEqual(self.branch(run, "a"), "tandem/dodaj-tamnu-temu-boje-ikonice-i-djacki/a")
        self.assertTrue(os.path.isdir(self.worktree(run, "a")))
        # The same goal again gets a name of its own.
        again = json.loads(self.orch("init", "--goal", goal, "--setup", "{}").stdout)["run"]
        self.assertEqual(again["branch"], "tandem/dodaj-tamnu-temu-boje-ikonice-i-djacki-2/result")

    def test_a_run_from_before_names_keeps_its_branches(self):
        run = self.start()
        data = self.run_json(run)
        del data["name"]  # how runs started before branches were named for their goal look
        with open(os.path.join(self.repo, ".tandem", "runs", run, "run.json"), "w") as f:
            json.dump(data, f)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.assertEqual(self.branch(run, "a"), f"tandem/{run}-a")
        self.assertTrue(os.path.isdir(os.path.join(self.repo, ".tandem", "worktrees", f"{run}-a")))

    def test_merge_conflict_goes_back_to_the_worker(self):
        run = self.start(fix_rounds=0)  # resolving a conflict Tandem's merge caused uses no fix round
        self.plan(run, [task("a", brief="WRITE same.txt from a", owns=["one"]),
                        task("b", brief="WRITE same.txt from b", owns=["two"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.act("merge", run, "--task", "a")
        conflict = self.act("merge", run, "--task", "b", ok=False)
        self.assertEqual(self.status(conflict["run"], "b"), "conflict")
        _, events = self.poll_until(run, lambda v, e: any(x["type"] == "digest" and "conflict" in x["text"] for x in e))
        sent = self.act("review", run, "--task", "b", "--verdict", "changes", "--notes", "WRITE same.txt resolved")
        self.assertEqual(self.status(sent["run"], "b"), "running")
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.act("review", run, "--task", "b", "--verdict", "approve")
        self.assertIn("Merged b", self.act("merge", run, "--task", "b")["text"])
        self.assertEqual(self.git("show", f"{self.branch(run)}:same.txt"), "resolved")

    def test_conflict_fix_after_skipped_proposals_goes_to_the_builder(self):
        run = self.start(simplify=True)
        self.plan(run, [task("a", brief="WRITE same.txt from a", owns=["one"]),
                        task("b", brief="WRITE same.txt from b", owns=["two"])])
        self.act("approve", run)
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        builder = next(t["thread"] for t in view["tasks"] if t["id"] == "b")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.poll_until(run, lambda v, e: self.status(v, "a") == "proposals" and self.status(v, "b") == "proposals")
        for task_id in ("a", "b"):
            self.act("apply", run, "--task", task_id)  # the user clicks "Skip all"
        self.act("merge", run, "--task", "a")
        self.assertEqual(self.status(self.act("merge", run, "--task", "b", ok=False)["run"], "b"), "conflict")
        self.act("review", run, "--task", "b", "--verdict", "changes", "--notes", "WRITE same.txt resolved")
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        resumed = [c["params"]["threadId"] for c in self.server_calls() if c.get("method") == "thread/resume"]
        self.assertEqual(resumed, [builder])
        self.act("review", run, "--task", "b", "--verdict", "approve")
        self.assertIn("Merged b", self.act("merge", run, "--task", "b")["text"])

    def test_merges_skip_git_hooks_and_show_gits_own_errors(self):
        hook = os.path.join(self.repo, ".git", "hooks", "commit-msg")
        with open(hook, "w") as f:  # commitlint-like: rejects every subject Tandem writes
            f.write('#!/bin/sh\necho "commitlint: subject must be conventional" >&2\nexit 1\n')
        os.chmod(hook, 0o755)
        run = self.start()
        self.plan(run, [task("a", owns=["a"]), task("b", owns=["b"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.assertIn("Merged a", self.act("merge", run, "--task", "a")["text"])
        integration = self.worktree(run, "result")
        with open(os.path.join(integration, "b.txt"), "w") as f:  # an untracked file the merge would overwrite
            f.write("local\n")
        refused = self.act("merge", run, "--task", "b", ok=False)
        self.assertIn("Could not merge b", refused["text"])
        self.assertIn("b.txt", refused["text"])
        self.assertEqual(self.status(refused["run"], "b"), "approved")
        os.remove(os.path.join(integration, "b.txt"))
        self.assertIn("Merged b", self.act("merge", run, "--task", "b")["text"])

    def test_conflict_markers_are_never_committed(self):
        run = self.start()
        self.plan(run, [task("a", brief="WRITE same.txt from a", owns=["one"]),
                        task("b", brief="WRITE same.txt from b", owns=["two"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.act("merge", run, "--task", "a")
        self.act("merge", run, "--task", "b", ok=False)
        # The worker answers without resolving anything; the user still cannot merge the markers.
        self.act("review", run, "--task", "b", "--verdict", "changes", "--notes", "please look")
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.act("review", run, "--task", "b", "--verdict", "approve")
        refused = self.act("merge", run, "--task", "b", ok=False)
        self.assertIn("conflict markers", refused["text"])
        self.assertEqual(self.status(refused["run"], "b"), "conflict")  # back to the orchestrator, not a dead end

    def test_workers_run_in_the_codex_app_when_it_takes_the_thread(self):
        self.fake_app(6)
        run = self.start()
        self.plan(run, [task("a", owns=["a"]), task("r", role="reviewer", brief="Review README.md")])
        self.act("approve", run)
        deadline = time.time() + 15
        while not self.queued() and time.time() < deadline:
            time.sleep(0.2)
        self.assertIn(f"[tandem · run {run} · task a · message #1 from the orchestrator]", self.queued()[0])
        # A read-only role stays in the background: the app would run it with the app's own sandbox.
        self.poll_until(run, lambda v, e: self.status(v, "r") == "reported")
        self.assertEqual(len(self.queued()), 1)
        turns = [c["params"]["input"][0]["text"] for c in self.server_calls() if c.get("method") == "turn/start"]
        self.assertEqual([text.split("\n")[0] for text in turns],
                         [f"[tandem · run {run} · task r · message #1 from the orchestrator]"])

    def test_cleanup_leaves_the_threads_a_codex_app_keeps_and_archives_them_later(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        thread = next(t["thread"] for t in view["tasks"])
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.act("merge", run, "--task", "a")
        self.poll_until(run, lambda v, e: v["status"] == "done")
        self.hold_thread(thread)  # the Codex app has the worker's thread open, so Codex does not archive it
        cleaned = self.act("cleanup", run)
        self.assertIn("still open in the Codex app", cleaned["text"])
        self.assertEqual((cleaned["run"]["cleanup"]["worktrees"], cleaned["run"]["cleanup"]["cleaned"]), (0, True))
        self.assertEqual([t["thread"] for t in cleaned["run"]["cleanup"]["threads"]], [thread])
        self.held.close()  # the app lets go of it (it restarted)
        again = self.act("cleanup", run)
        self.assertEqual(again["run"]["cleanup"]["threads"], [])
        with open(os.path.join(self.tmp, "archived.txt")) as f:
            self.assertEqual(f.read().split(), [thread])

    def test_stopping_a_worker_in_the_codex_app_waits_for_its_turn(self):
        self.fake_app(5)
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        deadline = time.time() + 15
        while not self.queued() and time.time() < deadline:
            time.sleep(0.2)
        time.sleep(0.5)  # the runner ends once it has handed the turn to the app
        stopped = self.act("stop", run, "--task", "a")
        self.assertEqual(self.status(stopped["run"], "a"), "stopping")
        self.assertIn("Still running in the Codex app: Task a", stopped["text"])
        self.assertEqual(self.status(self.act("cleanup", run)["run"], "a"), "stopping")
        self.assertTrue(os.path.isdir(self.worktree(run, "a")))
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "cancelled", timeout=20)  # the app closed

    def test_cancel_stops_a_running_worker(self):
        self.slow_codex(20)
        run = self.start(workers={"max_parallel": 1})
        self.plan(run, [task("a", owns=["a"]), task("b", owns=["b"])])
        self.act("approve", run)
        pid = self.run_json(run)["tasks"][0]["runner_pid"]
        self.act("cancel", run, "--task", "a")
        deadline = time.time() + 5
        while self.runner_running(pid) and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(self.runner_running(pid))
        self.act("stop", run)  # b took the free slot; stop its runner too

    def test_a_worker_whose_runner_died_fails(self):
        self.slow_codex(30)
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        os.killpg(self.run_json(run)["tasks"][0]["runner_pid"], signal.SIGKILL)  # a crash, a restart
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "failed")
        self.assertIn("runner stopped", next(t["error"] for t in view["tasks"]))

    def test_a_report_read_by_a_poll_that_failed_is_not_lost(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.wait_for_turn(f"{run}-a", 1)
        runs = os.path.join(self.repo, ".tandem", "runs", run)
        os.chmod(runs, 0o555)  # the poll reads the report, then cannot save the run (as if it were killed)
        try:
            self.assertNotEqual(self.orch("poll", "--run", run, ok=False).returncode, 0)
        finally:
            os.chmod(runs, 0o755)
        self.assertEqual(self.status(self.run_json(run), "a"), "running")
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.assertIn("ANSWER", self.run_json(run)["tasks"][0]["report"])

    def test_an_interrupted_start_is_picked_up(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.wait_for_turn(f"{run}-a", 1)
        saved = self.run_json(run)  # as if approve was killed before it saved the run
        saved["tasks"][0].update(status="pending", turns=0)
        saved["counters"]["dispatches"] = 0
        with open(os.path.join(self.repo, ".tandem", "runs", run, "run.json"), "w") as f:
            json.dump(saved, f)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.assertEqual(len([c for c in self.server_calls() if c.get("method") == "thread/start"]), 1)

    def test_chats_do_not_join_a_workers_thread(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        thread = next(t["thread"] for t in view["tasks"])
        refused = subprocess.run([AGENT_CHAT, "open", "--room", "chat", "--join", "--codex-thread", thread, "--cd", self.repo],
                                 env=self.env, capture_output=True, text=True)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("worker of an orchestrated run", refused.stderr)
        rows = json.loads(subprocess.run([AGENT_CHAT, "threads", "--json", "--cd", self.repo], env=self.env,
                                         capture_output=True, text=True).stdout)
        self.assertTrue(next(row["worker"] for row in rows if row["id"] == thread))

    def test_a_worker_thread_cannot_orchestrate_from_the_codex_app(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        view, _ = self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.env["CODEX_THREAD_ID"] = next(t["thread"] for t in view["tasks"])  # no TANDEM_SPAWNED in the app
        self.assertEqual(self.orch("init", "--goal", "More", ok=False).returncode, 4)

    def test_sandboxed_workers_live_in_their_worktree(self):
        run = self.start(workers={"access": "worktree"})
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        start = next(c["params"] for c in self.server_calls() if c.get("method") == "thread/start")
        self.assertEqual((start["sandbox"], start["cwd"]), ("workspace-write", self.worktree(run, "a")))
        self.assertNotIn("cwd", next(c["params"] for c in self.server_calls() if c.get("method") == "turn/start"))

    def test_parallel_limit_and_overlap(self):
        run = self.start(workers={"max_parallel": 2})
        self.plan(run, [task("a", owns=["src"]), task("b", owns=["src/inner"]), task("c", owns=["docs"])])
        approved = self.act("approve", run)
        running = sorted(t["id"] for t in approved["run"]["tasks"] if t["status"] == "running")
        self.assertEqual(running, ["a", "c"])

    def test_a_read_only_run_starts_tasks_on_the_same_paths_together(self):
        run = self.start(workers={"max_parallel": 2, "access": "read-only"})
        self.plan(run, [task("a", owns=["src"]), task("b", owns=["src"])])
        approved = self.act("approve", run)
        self.assertEqual(sorted(t["id"] for t in approved["run"]["tasks"] if t["status"] == "running"), ["a", "b"])
        self.assertEqual([t["read_only"] for t in approved["run"]["tasks"]], [True, True])

    def test_after_a_conflict_a_tasks_diff_is_its_own_work(self):
        run = self.start()
        self.plan(run, [task("a", brief="WRITE same.txt from a\nWRITE only-a.txt from a", owns=["one"]),
                        task("b", brief="WRITE same.txt from b", owns=["two"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported" and self.status(v, "b") == "reported")
        for task_id in ("a", "b"):
            self.act("review", run, "--task", task_id, "--verdict", "approve")
        self.act("merge", run, "--task", "a")
        self.assertEqual(self.status(self.act("merge", run, "--task", "b", ok=False)["run"], "b"), "conflict")
        diff = self.orch("diff", "--run", run, "--task", "b", "--stat").stdout
        self.assertIn("same.txt", diff)
        self.assertNotIn("only-a.txt", diff)  # a's merged work is the run's, not b's

    def test_a_simplifier_that_fails_leaves_the_task_approved(self):
        self.env["FAKE_FAIL_SCHEMA"] = "1"
        run = self.start(simplify=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.act("review", run, "--task", "a", "--verdict", "approve")
        view, events = self.poll_until(run, lambda v, e: self.status(v, "a") == "approved")
        shown = next(t for t in view["tasks"] if t["id"] == "a")
        self.assertIn("simplifier could not finish", shown["error"])
        self.assertEqual(shown["thread"], self.run_json(run)["tasks"][0]["thread"])  # the builder's thread again

    def test_stopping_the_simplifier_keeps_the_approved_change(self):
        run = self.start(simplify=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.slow_codex(5)
        self.act("review", run, "--task", "a", "--verdict", "approve")
        stopped = self.act("stop", run, "--task", "a")
        self.assertEqual(self.status(stopped["run"], "a"), "approved")
        self.assertIn("Stopped the simplifier", stopped["text"])

    def test_the_orchestrator_cannot_stop_what_waits_for_the_user(self):
        run = self.start(fix_rounds=0)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.act("review", run, "--task", "a", "--verdict", "changes", "--notes", "more")
        refused = self.orch("stop", "--run", run, "--task", "a", ok=False)
        self.assertIn("the user's", refused.stderr)
        self.assertEqual(self.status(self.act("cancel", run, "--task", "a")["run"], "a"), "cancelled")

    def test_approve_takes_only_the_plan_the_user_saw(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.plan(run, [task("b")])  # a new plan lands while the user looks at the first
        refused = self.orch("approve", "--run", run, "--tasks", "a", ok=False)
        self.assertIn("changed", refused.stderr)
        self.assertEqual(self.status(self.act("approve", run, "--tasks", "b")["run"], "b"), "running")

    def test_claude_task_goes_to_the_orchestrator(self):
        run = self.start()
        self.plan(run, [task("d", role="browser-tester", brief="Check the hello screen in the browser")])
        self.act("approve", run)
        _, events = self.poll_until(run, lambda v, e: any(x["type"] == "digest" for x in e))
        self.assertIn("yours", events[0]["text"])
        self.assertEqual(self.server_calls(), [])
        self.act("done", run, "--task", "d", "--summary", "Frames are in Figma")
        self.poll_until(run, lambda v, e: v["status"] == "done")

    def test_read_only_role_finishes_without_merge(self):
        run = self.start()
        self.plan(run, [task("r", role="reviewer", brief="Review README.md")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "r") == "reported")
        self.assertEqual(next(c["params"]["sandbox"] for c in self.server_calls() if c.get("method") == "thread/start"),
                         "read-only")
        done = self.act("review", run, "--task", "r", "--verdict", "approve")
        self.assertEqual(self.status(done["run"], "r"), "done")

    def test_budget_used_up_on_a_review_pauses_for_more(self):
        run = self.start(budget=1)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        refused = self.orch("review", "--run", run, "--task", "a", "--verdict", "changes", "--notes", "WRITE a.txt x", ok=False)
        self.assertIn("worker turns are used up", refused.stderr)
        self.assertIn("Allow 10 more in the Tandem panel", refused.stderr)
        self.assertEqual(json.loads(self.orch("status", "--run", run, "--json").stdout)["run"]["paused"], "budget")
        self.act("more", run)
        self.assertEqual(self.status(self.act("review", run, "--task", "a", "--verdict", "changes", "--notes", "WRITE a.txt x")
                                     ["run"], "a"), "running")

    def test_tasks_on_the_same_paths_wait_for_the_merge(self):
        run = self.start(workers={"max_parallel": 2})
        self.plan(run, [task("a", brief="WRITE src.txt from a", owns=["src"]),
                        task("b", brief="WRITE src.txt from b", owns=["src/*.ts"])])
        approved = self.act("approve", run)
        self.assertEqual(next(t["waits_for"] for t in approved["run"]["tasks"] if t["id"] == "b"), ["a"])
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertEqual(self.status(self.act("status", run, "--json")["run"], "b"), "pending")  # a is not merged yet
        merged = self.act("merge", run, "--task", "a")
        self.assertEqual(self.status(merged["run"], "b"), "running")
        self.poll_until(run, lambda v, e: self.status(v, "b") == "reported")
        self.act("review", run, "--task", "b", "--verdict", "approve")
        self.assertIn("Merged b", self.act("merge", run, "--task", "b")["text"])  # b started with a's change: no conflict

    def test_cleanup_during_a_run_keeps_unfinished_worktrees(self):
        run = self.start(simplify=True)
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.poll_until(run, lambda v, e: self.status(v, "a") == "proposals")
        self.act("cleanup", run)
        self.assertTrue(os.path.isdir(self.worktree(run, "a")))
        self.act("apply", run, "--task", "a", "--items", "2")
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")

    def test_a_task_whose_worker_never_started(self):
        run = self.start()
        self.git("branch", f"tandem/{self.run_json(run)['name']}/a")  # git worktree add then fails
        self.plan(run, [task("a")])
        self.assertEqual(self.status(self.act("approve", run)["run"], "a"), "failed")
        refused = self.orch("send", "--run", run, "--task", "a", "--message", "try again", ok=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("never started", refused.stderr)

    def test_copy_takes_only_git_ignored_files(self):
        self.assertIn("git-ignored", self.orch("init", "--goal", "x", "--setup", json.dumps({"copy": ["README.md"]}),
                                               ok=False).stderr)
        with open(os.path.join(self.repo, ".git", "info", "exclude"), "a") as f:
            f.write(".env.local\n")
        with open(os.path.join(self.repo, ".env.local"), "w") as f:
            f.write("API_KEY=test-only\n")
        run = self.start(copy=[".env.local"])
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        self.assertTrue(os.path.exists(os.path.join(self.worktree(run, "a"), ".env.local")))
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.act("merge", run, "--task", "a")
        self.assertNotIn(".env.local", self.git("ls-tree", "--name-only", self.branch(run)).split())

    def test_files_in_other_encodings_do_not_break_diff_or_merge(self):
        run = self.start()
        self.plan(run, [task("a")])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        with open(os.path.join(self.worktree(run, "a"), "legacy.txt"), "wb") as f:
            f.write("Ime: Đurađ \n".encode("cp1250"))  # Windows-1250, with trailing whitespace
        self.assertIn("legacy.txt", self.orch("diff", "--run", run, "--task", "a").stdout)
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn("Merged a", self.act("merge", run, "--task", "a")["text"])

    def test_a_run_from_a_linked_worktree_starts_at_its_commit(self):
        linked = os.path.join(self.tmp, "feature wt")
        self.git("worktree", "add", "-q", "-b", "feature", linked)
        with open(os.path.join(linked, "feature.txt"), "w") as f:
            f.write("feature work\n")
        for argv in (["add", "feature.txt"], ["commit", "-q", "-m", "feature"]):
            subprocess.run(["git", "-C", linked, *argv], env=self.env, check=True)
        head = subprocess.run(["git", "-C", linked, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        started = json.loads(subprocess.run([AGENT_CHAT, "orch", "init", "--goal", "x", "--cd", linked], env=self.env,
                                            capture_output=True, text=True).stdout)
        self.assertEqual(self.run_json(started["run"]["id"])["base"], head)
        self.assertIn("from feature", started["text"])
        self.assertEqual(self.git("show", f"{started['run']['branch']}:feature.txt"), "feature work")

    def test_budget_pauses_and_more_resumes(self):
        run = self.start(budget=1, workers={"max_parallel": 2})
        self.plan(run, [task("a", owns=["a"]), task("b", owns=["b"])])
        approved = self.act("approve", run)
        self.assertEqual(approved["run"]["paused"], "budget")
        self.assertEqual(self.status(approved["run"], "b"), "pending")
        more = self.act("more", run)
        self.assertEqual(self.status(more["run"], "b"), "running")

    def test_plan_is_checked(self):
        run = self.start()
        for bad, message in (([task("a"), task("a")], "new id"), ([task("a", role="wizard")], "role must be"),
                             ([task("a", deps=["zz"])], "unknown dependency"),
                             ([task("a", deps=["b"]), task("b", deps=["a"])], "cycle"),
                             ([task("a", owns=["../x"])], "owns")):
            self.assertIn(message, self.plan(run, bad, ok=False).stderr)
        self.plan(run, [task("a")])
        self.act("reject", run)
        self.assertEqual(json.loads(self.orch("status", "--run", run, "--json").stdout)["run"]["tasks"], [])

    def test_the_plan_view_has_each_whole_brief_and_whether_a_task_is_read_only(self):
        run = self.start()
        brief = "Read the code first. " * 400  # 8,400 characters: the view sends a brief whole
        tasks = json.loads(self.plan(run, [task("a", brief=brief), task("b", role="reviewer")]).stdout)["run"]["tasks"]
        self.assertEqual(tasks[0]["brief"], brief.strip())
        self.assertEqual([t["read_only"] for t in tasks], [False, True])

    def test_stop_cancels_and_cleanup_keeps_unmerged_work(self):
        run = self.start()
        self.plan(run, [task("a"), task("b", deps=["a"])])
        self.act("approve", run)
        self.poll_until(run, lambda v, e: self.status(v, "a") == "reported")
        stopped = self.act("stop", run)
        self.assertEqual(stopped["run"]["status"], "stopped")
        self.assertEqual({t["status"] for t in stopped["run"]["tasks"]}, {"cancelled"})
        cleaned = self.act("cleanup", run)
        self.assertIn(self.branch(run, "a"), cleaned["text"])
        self.assertEqual(self.git("show", f"{self.branch(run, 'a')}:a.txt"), "hello from a")

    def test_workers_cannot_orchestrate(self):
        self.env["TANDEM_SPAWNED"] = "1"
        self.assertEqual(self.orch("init", "--goal", "x", ok=False).returncode, 4)


class CodexOrchestratorTests(OrchHelpers, Base):
    """A run started from a Codex thread: the conductor sends each update into that thread as a turn."""

    def setUp(self):
        super().setUp()
        self.commit_initial()
        self.env.update(CODEX_THREAD_ID=THREAD, TANDEM_POLL_SECONDS="0.2")
        self.runs = []

    def tearDown(self):
        for run in self.runs:  # before the folder goes: a conductor still running would outlive the test
            self.stop(run)
        super().tearDown()

    def stop(self, run):
        self.orch("stop", "--run", run, ok=False)
        with open(os.path.join(self.repo, ".tandem", "runs", run, "conductor.lock"), "a") as lock:
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except OSError:
                    time.sleep(0.1)

    def updates(self):
        return [c["params"]["input"][0]["text"] for c in self.server_calls()
                if c.get("method") == "turn/start" and c["params"]["threadId"] == THREAD]

    def wait_for_update(self, needle, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = [text for text in self.updates() if needle in text]
            if found:
                return found[-1]
            time.sleep(0.2)
        self.fail(f"no update with {needle!r}: {self.updates()}")

    def test_codex_orchestrates_and_gets_updates_in_its_thread(self):
        started = json.loads(self.orch("init", "--goal", "Say hello", "--setup",
                                       json.dumps({"simplify": True, "auto_merge": False})).stdout)
        run = started["run"]["id"]
        self.runs.append(run)
        self.assertEqual((started["run"]["orchestrator"]["vendor"], started["run"]["conductor"]), ("codex", True))
        self.assertIn("orch plan --run", started["text"])
        self.assertIn("ask them to approve", json.loads(self.plan(run, [task("a")]).stdout)["text"])
        self.assertEqual(self.orch("poll", "--run", run, ok=False).returncode, 3)

        self.act("approve", run)
        update = self.wait_for_update("a · Task a · implementer · reported")
        self.assertIn(f"[tandem · run {run} · update #1 from Tandem]", update)
        self.assertIn("orch diff --run", update)
        self.assertIn("ask-claude", update)
        self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn("orch apply --run", self.wait_for_update("the simplifier proposes"))
        self.act("apply", run, "--task", "a", "--items", "2")
        self.wait_for_update("applied the simplifications")
        approved = self.act("review", run, "--task", "a", "--verdict", "approve")
        self.assertIn("orch merge --run", approved["text"])
        self.act("merge", run, "--task", "a")
        self.assertIn("orch cleanup --run", self.wait_for_update("is finished"))
        self.assertEqual(json.loads(self.orch("status", "--run", run, "--json").stdout)["run"]["status"], "done")

    def test_watch_restarts_the_conductor(self):
        run = json.loads(self.orch("init", "--goal", "Say hello").stdout)["run"]["id"]
        self.runs.append(run)
        self.assertIn("conductor runs", self.act("watch", run)["text"])
        self.assertIn("Codex orchestrates it from thread", self.orch("status", "--run", run).stdout)


class OrchLogicTests(unittest.TestCase):
    """The orchestrator's own logic, called directly."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.join(ROOT, "codex-skills", "tandem", "scripts"))
        import tandem_orch
        cls.orch = tandem_orch

    def test_simplifier_answers_outside_the_schema_become_one_note(self):
        run = {"orchestrator": {"vendor": "claude"}}
        for text in ('{"status": "proposals", "items": 1}', '{"status": "proposals", "items": "x"}', "plain words", "[1, 2]"):
            task = {"id": "a"}
            self.orch.take_proposals(run, task, text)
            self.assertEqual((task["status"], [p["kind"] for p in task["proposals"]]), ("proposals", ["note"]), text)
        task = {"id": "a"}
        self.orch.take_proposals(run, task, '{"status": "no_change", "summary": "fine", "items": []}')
        self.assertEqual(task["status"], "approved")

    def test_a_simplifier_answer_with_text_around_its_json_still_gives_each_proposal(self):
        run = {"orchestrator": {"vendor": "claude"}}
        answer = json.dumps({"status": "proposals", "summary": "two ideas", "items": [{"why": "first"}, {"why": "second"}]})
        for text in ("```json\n" + answer + "\n```", answer + "\n## Report\nStatus: done", answer + "\n#tandem:r-x-a.simplify:1"):
            task = {"id": "a"}
            self.orch.take_proposals(run, task, text)
            self.assertEqual(([p["why"] for p in task["proposals"]], task["simplifier_summary"]), (["first", "second"], "two ideas"), text)

    def test_overlapping_paths(self):
        catalog = {"implementer": {}, "reviewer": {"access": "read-only"}}

        def owns(*paths, role="implementer"):
            return {"role": role, "owns": list(paths)}
        def overlaps(a, b, catalog):
            return self.orch.overlaps(FULL_ACCESS_RUN, a, b, catalog)
        self.assertTrue(overlaps(owns("src"), owns("src/inner"), catalog))
        self.assertFalse(overlaps(owns("src"), owns("src2"), catalog))
        self.assertTrue(overlaps(owns("src/foo*.py"), owns("src/foobar*.py"), catalog))
        self.assertFalse(overlaps(owns("src/foo*.py"), owns("src/bar.py"), catalog))
        self.assertTrue(overlaps(owns("src/*"), owns("src/a/b.ts"), catalog))
        self.assertFalse(overlaps(owns("src/*"), owns("src2/x.ts"), catalog))
        self.assertTrue(overlaps(owns(), owns("docs"), catalog))
        self.assertFalse(overlaps(owns(), owns(role="reviewer"), catalog))

    def test_owned_paths_are_compared_in_one_spelling(self):
        catalog = {"implementer": {"vendor": "codex"}}
        tasks = self.orch.validate_tasks([task("a", owns=["./src/app.ts"]), task("b", owns=["src//app.ts/"])], [], catalog)
        self.assertEqual([t["owns"] for t in tasks], [["src/app.ts"], ["src/app.ts"]])
        self.assertTrue(self.orch.overlaps(FULL_ACCESS_RUN, *tasks, catalog))
        with self.assertRaises(SystemExit):
            self.orch.validate_tasks([task("c", owns=["."])], [], catalog)

    def test_activity_is_the_last_step_of_the_current_turn(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        os.makedirs(os.path.join(root, ".tandem", "r-x-a"))
        rollout = os.path.join(root, "rollout.jsonl")
        with open(os.path.join(root, ".tandem", "r-x-a", "watch-state.json"), "w") as f:
            json.dump({"rollout": rollout}, f)
        task = {"room": "r-x-a"}

        def write(*records):
            with open(rollout, "a") as f:
                for record in records:
                    f.write(json.dumps(record) + "\n")

        def done(item):
            return {"type": "event_msg", "payload": {"type": "item_completed", "item": item, "completed_at_ms": 1792961334788}}
        write({"type": "event_msg", "payload": {"type": "task_started"}})
        self.assertEqual(self.orch.activity(root, task), {"text": "Starting", "at": None})
        write(done({"type": "Reasoning", "summary_text": ["**Reading the brief**"]}))
        self.assertEqual(self.orch.activity(root, task)["text"], "Reading the brief")
        write(done({"type": "CommandExecution", "command": ["/bin/zsh", "-lc", "npm test\nnpm run lint"]}),
              done({"type": "Reasoning", "summary_text": []}))
        self.assertEqual(self.orch.activity(root, task), {"text": "Ran npm test", "at": 1792961334.788})
        write(done({"type": "McpToolCall", "server": "codex_apps", "tool": "figma.use_figma", "appName": "Figma",
                    "actionName": "use_figma"}))
        self.assertEqual(self.orch.activity(root, task)["text"], "Used Figma: use_figma")
        write({"type": "event_msg", "payload": {"type": "task_complete"}})
        self.assertIsNone(self.orch.activity(root, task))
