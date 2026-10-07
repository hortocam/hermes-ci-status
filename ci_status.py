#!/usr/bin/env python3
"""ci_status.py — CI / PR status collector for the Hermes desktop "CI" pane.

Reads git repos on this host, asks their forge (GitHub via `gh`, Gitea via its
REST API) for the check-run rollup of the branch you are actually on, plus the
pull request that branch belongs to. Emits one stable JSON document.

Designed to be driven by the `hermes-ci-status` desktop plugin, which calls it
through the desktop's own `shell.exec` RPC — so it must be:
  * stdlib only (any Python 3.9+),
  * non-interactive, no prompts, no writes,
  * bounded in time (every network call has a timeout),
  * tolerant: a repo whose forge is unreachable reports the error, never crashes.

Usage
-----
    ci_status.py --json                     # every watched repo
    ci_status.py --json --repo <path>       # one repo (repeatable)
    ci_status.py --json --repo <path> --branch <b>   # pin a branch
    ci_status.py --json --config <file>     # explicit config
    ci_status.py --selftest                 # offline checks, exit 0/1

Config (~/.hermes/ci-status/config.json), optional:
    {"repos": ["/abs/path", ...], "auto_scan": true, "scan_root": "/home/hermes/projects"}
`auto_scan` (default true) unions `repos` with immediate git children of
`scan_root`; a repo is watched if it has a remote that resolves to a known forge.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
CONFIG_PATH = HOME / "ci-status" / "config.json"
DEFAULT_SCAN_ROOT = str(Path.home() / "projects")

GH_TIMEOUT = 20.0
GIT_TIMEOUT = 10.0
GITEA_TIMEOUT = 8.0

# Branches nobody wants a "which PR is this" answer for: trunk work has no PR.
TRUNK = {"main", "master", "dev", "develop", "trunk"}

# ── colour language ──────────────────────────────────────────────────────────
# The UI renders RAG; the collector only classifies. Keep the vocabulary small
# and total so the client never has to guess.
CHECK_STATES = ("success", "failure", "pending", "neutral", "none", "unknown")


def _run(cmd, cwd=None, timeout=GIT_TIMEOUT, env=None):
    """Run a command; return (ok, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout, stdin=subprocess.DEVNULL,
            env=env,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, "", f"{type(exc).__name__}: {exc}"
    return proc.returncode == 0, proc.stdout or "", proc.stderr or ""


def _git(repo: Path, *args, timeout=GIT_TIMEOUT):
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    env.setdefault("GIT_OPTIONAL_LOCKS", "0")
    return _run(["git", "-C", str(repo), *args], timeout=timeout, env=env)


def _git_ok(repo: Path, *args, timeout=GIT_TIMEOUT) -> str:
    ok, out, _ = _git(repo, *args, timeout=timeout)
    return out.strip() if ok else ""


# ── forge resolution ─────────────────────────────────────────────────────────

_REMOTE_PATTERNS = (
    re.compile(r"^(?:https?|git\+ssh|ssh)://(?:[^@/]+@)?(?P<host>[^:/]+)(?::\d+)?/(?P<slug>[^/]+/[^/]+?)(?:\.git)?/?$"),
    re.compile(r"^(?:[^@]+@)?(?P<host>[^:/]+):(?P<slug>[^/]+/[^/]+?)(?:\.git)?/?$"),  # scp-like
)


def parse_remote(url: str):
    """(host, 'owner/name') from a git remote URL, or None."""
    url = (url or "").strip()
    if not url:
        return None
    for pat in _REMOTE_PATTERNS:
        m = pat.match(url)
        if m:
            slug = m.group("slug").strip("/")
            if slug.endswith(".git"):
                slug = slug[:-4]
            return m.group("host").split(":")[0], slug
    return None


def classify_host(host: str) -> str:
    host = (host or "").lower()
    if "github" in host:
        return "github"
    # This lab's Gitea is a plain LAN address; any other non-GitHub host with a
    # token-ish forge is treated as gitea rather than silently dropped.
    return "gitea" if host else "unknown"


# ── GitHub (gh CLI) ──────────────────────────────────────────────────────────

_GH_QUERY = """
query($owner:String!,$name:String!,$ref:String!){
  repository(owner:$owner,name:$name){
    object(expression:$ref){
      ... on Commit {
        oid
        statusCheckRollup { state }
        checkSuites(first:20){
          nodes { status conclusion checkRuns(first:60){ nodes{ name status conclusion detailsUrl } } }
        }
        commitStatus: statusCheckRollup {
          contexts(first:100){ totalCount nodes{
            __typename
            ... on StatusContext { context state targetUrl }
          } }
        }
      }
    }
    pullRequests(headRefName:$ref, first:5, orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{ number state isDraft title url headRefOid mergeable reviewDecision }
    }
  }
}
"""

# GitHub's own vocabulary, mapped onto the pane's. A rollup reports the WORKFLOW
# outcome; the UI wants the worst of the individual jobs, so the check runs are
# folded here rather than trusting the summary state.
_ROLLUP_MAP = {
    "SUCCESS": "success", "FAILURE": "failure", "ERROR": "failure",
    "PENDING": "pending", "EXPECTED": "pending", "NEUTRAL": "neutral",
    "STARTUP_FAILURE": "failure", "STALE": "neutral",
}


def _fold_suites(suites: list) -> list:
    """Flatten checkSuites → one context per check run (the job-level view).

    ``statusCheckRollup.contexts`` reports the workflow's aggregate, which reads
    green even when a job inside it failed. The pane badges jobs, so suites are
    the source of truth and their runs are what get folded.
    """
    folded = []
    for suite in suites or []:
        for run in ((suite or {}).get("checkRuns") or {}).get("nodes") or []:
            if not run:
                continue
            folded.append({
                "name": run.get("name") or "check",
                "type": "check",
                "status": run.get("status") or "",
                "conclusion": run.get("conclusion") or None,
                "url": run.get("detailsUrl") or "",
                "suiteStatus": (suite or {}).get("status") or "",
            })
    return folded


def _gh_ready() -> bool:
    if not shutil.which("gh"):
        return False
    env = dict(os.environ)
    env.setdefault("GH_PROMPT_DISABLED", "1")
    ok, _, _ = _run(["gh", "auth", "status"], timeout=GH_TIMEOUT, env=env)
    return ok


def _classify_context(node: dict) -> dict:
    if node.get("__typename") == "StatusContext":
        state = (node.get("state") or "").upper()
        return {
            "name": node.get("context") or "status",
            "type": "status",
            "status": "COMPLETED",
            "conclusion": {"SUCCESS": "SUCCESS", "FAILURE": "FAILURE",
                           "ERROR": "FAILURE", "PENDING": "PENDING"}.get(state, state),
            "url": node.get("targetUrl") or "",
        }
    return {
        "name": node.get("name") or "check",
        "type": "check",
        "status": node.get("status") or "",
        "conclusion": node.get("conclusion") or None,
        "url": node.get("detailsUrl") or "",
    }


def _tally(contexts: list) -> dict:
    """Fold a check list into counts + one RAG state."""
    counts = {"passed": 0, "failed": 0, "pending": 0, "skipped": 0, "neutral": 0}
    for c in contexts:
        conclusion = (c.get("conclusion") or "").upper()
        status = (c.get("status") or "").upper()
        if c.get("type") == "status" and not conclusion:
            conclusion = status
        if conclusion in ("SUCCESS", "PASSED"):
            counts["passed"] += 1
        elif conclusion in ("FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"):
            counts["failed"] += 1
        elif conclusion in ("SKIPPED",):
            counts["skipped"] += 1
        elif conclusion in ("NEUTRAL", "STALE"):
            counts["neutral"] += 1
        elif status in ("QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", ""):
            counts["pending"] += 1
        else:
            counts["pending"] += 1

    total = len(contexts)
    if total == 0:
        state = "none"
    elif counts["failed"]:
        state = "failure"
    elif counts["pending"]:
        state = "pending"
    elif counts["passed"]:
        state = "success"
    else:
        state = "neutral"
    return {"state": state, "total": total, **counts}


def _pr_payload(node: dict, head_sha: str) -> dict:
    return {
        "number": node.get("number") or 0,
        "state": (node.get("state") or "").lower(),
        "draft": bool(node.get("isDraft")),
        "title": node.get("title") or "",
        "url": node.get("url") or "",
        "mergeable": (node.get("mergeable") or "").upper(),
        "reviewDecision": (node.get("reviewDecision") or "").upper(),
        "headSha": node.get("headRefOid") or "",
        # TRI-STATE, deliberately: True (matching), False (a PROVEN mismatch), or
        # None (no comparison was possible). The None case is real and common —
        # GitHub deletes the head branch on merge, so the local branch is left
        # with no upstream ref and its commit cannot be resolved by name. Folding
        # that into False reported "drift" on a merged PR: the opposite of the
        # truth, at a glance. Never collapse this back to a bool.
        "headMatches": (node.get("headRefOid") == head_sha) if head_sha else None,
    }


def github_branch(slug: str, branch: str, gh_ok: bool) -> dict:
    """Check rollup + PR for one (repo, branch) from GitHub."""
    if not gh_ok:
        return {"ok": False, "error": "gh unavailable or not authenticated"}

    owner, _, name = slug.partition("/")
    if not owner or not name:
        return {"ok": False, "error": f"unparsable repository slug {slug!r}"}

    env = dict(os.environ)
    env.setdefault("GH_PROMPT_DISABLED", "1")
    ok, out, err = _run(
        ["gh", "api", "graphql", "-f", f"query={_GH_QUERY}",
         "-f", f"owner={owner}", "-f", f"name={name}", "-f", f"ref={branch}"],
        timeout=GH_TIMEOUT, env=env,
    )
    if not ok:
        return {"ok": False, "error": (err or "gh api graphql failed").strip()[:300]}

    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": "gh returned non-JSON"}

    if payload.get("errors"):
        first = payload["errors"][0].get("message") or "graphql error"
        return {"ok": False, "error": str(first)[:300]}

    repo = ((payload.get("data") or {}).get("repository")) or {}
    commit = (repo.get("object") or {})
    head_sha = commit.get("oid") or ""

    # Jobs first (the badgeable unit), then legacy statuses as the long tail. The
    # rollup's own context list is deliberately NOT used: it repeats the suites
    # (and repeats them *unpopulated* when the caller does not also request the
    # CheckRun fields on that inline fragment), which manufactured a phantom
    # "check" row on top of the real job.
    contexts = _fold_suites(((commit.get("checkSuites") or {}).get("nodes")) or [])
    rollup = commit.get("statusCheckRollup") or {}
    legacy_raw = ((commit.get("commitStatus") or {}).get("contexts") or {}).get("nodes") or []
    legacy = [_classify_context(n) for n in legacy_raw
              if n and n.get("__typename") == "StatusContext"]
    contexts += [c for c in legacy if c["name"] not in {x["name"] for x in contexts}]
    contexts.sort(key=lambda c: c["name"])

    truncated = bool(((commit.get("commitStatus") or {}).get("contexts") or {})
                     .get("totalCount", 0) > len(legacy))

    tally = _tally(contexts)
    rollup_state = (rollup.get("state") or "").upper()
    if tally["total"] == 0 and rollup_state:
        tally["state"] = _ROLLUP_MAP.get(rollup_state, "unknown")

    pr = None
    for node in ((repo.get("pullRequests") or {}).get("nodes")) or []:
        if node:
            pr = _pr_payload(node, head_sha)
            break

    return {
        "ok": True, "branch": branch, "headSha": head_sha,
        "checkState": tally["state"], "counts": tally, "contexts": contexts, "pr": pr,
        "truncated": truncated,
    }


# ── Gitea (REST) ─────────────────────────────────────────────────────────────

def _gitea_token(cfg: dict) -> str:
    token = (os.environ.get("GITEA_TOKEN") or "").strip()
    if token:
        return token
    # Fall back to the `tea` CLI's own login store — this lab already signs tea
    # in, and the token is a path/credential pair we merely read, never print.
    tea_cfg = Path(cfg.get("tea_config") or Path.home() / ".config" / "tea" / "config.yml")
    try:
        text = tea_cfg.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    m = re.search(r"^\s*token:\s*(\S+)\s*$", text, re.MULTILINE)
    return m.group(1) if m else ""


def _has_ci_config(repo: Path, kind: str) -> bool:
    """Does this working copy carry CI config at all?

    Separates "no pipeline is wired up" from "the pipeline exists but nothing
    has run on this branch" — two states the UI must not blur into one grey
    dot. Local filesystem only; no network.
    """
    if kind == "github":
        workflows = repo / ".github" / "workflows"
    elif kind == "gitea":
        workflows = repo / ".gitea" / "workflows"
    else:
        return False
    try:
        if not workflows.is_dir():
            return False
        return any(p.suffix in (".yml", ".yaml") for p in workflows.iterdir() if p.is_file())
    except OSError:
        return False


def _tea_login_urls(tea_cfg: Path) -> list[str]:
    """Every `url:` in the tea CLI's login list, in order."""
    try:
        text = tea_cfg.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    section = text.split("logins:", 1)
    body = section[1] if len(section) > 1 else ""
    body = body.split("\npreferences:", 1)[0]
    return [m.group(1).strip().strip('"\'') for m in re.finditer(r"^\s*url:\s*(\S+)\s*$", body, re.MULTILINE)]


_GITEA_BASE_CACHE: dict[str, str] = {}


def _probe_gitea(base_url: str) -> bool:
    """Is a Gitea REST API answering here? Cheap, short-timeout, no raises."""
    import urllib.error
    import urllib.request
    try:
        req = urllib.request.Request(f"{base_url.rstrip('/')}/api/v1/version",
                                     headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as exc:
        # A 401/403 still proves a Gitea API lives here.
        return exc.code in (401, 403)
    except Exception:  # noqa: BLE001 — an unreachable candidate is just a miss
        return False


def _gitea_base(cfg: dict, hostname: str, remote_scheme: str = "https") -> str:
    """Resolve the Gitea API base for ``hostname``.

    The remote's own host is the *git* endpoint, which may be a DNS front door
    while the API answers on a different address entirely. Rather than guess,
    try the candidates a self-configuring host can offer and keep the first
    that answers: an explicit config entry, then every `tea` CLI login, then the
    remote host itself, then the usual Gitea dev port on the same host.
    """
    cached = _GITEA_BASE_CACHE.get(hostname)
    if cached:
        return cached

    declared = (cfg.get("forges") or {}).get(hostname) or (cfg.get("gitea") or {}).get("base_url")
    candidates: list[str] = []
    if declared:
        candidates.append(str(declared))
    if not cfg.get("ignore_tea_logins"):
        tea_cfg = Path(cfg.get("tea_config") or Path.home() / ".config" / "tea" / "config.yml")
        candidates += _tea_login_urls(tea_cfg)
    candidates.append(f"{remote_scheme}://{hostname}")
    candidates.append(f"http://{hostname}:3000")

    seen = set()
    for candidate in candidates:
        candidate = candidate.rstrip("/")
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if _probe_gitea(candidate):
            _GITEA_BASE_CACHE[hostname] = candidate
            return candidate

    # Nothing answered: hand back the best-looking guess so the error the UI
    # shows names a real address instead of an empty string.
    return candidates[0].rstrip("/") if candidates else f"http://{hostname}:3000"


def gitea_branch(base_url: str, slug: str, branch: str, token: str) -> dict:
    """Check state for one (repo, branch) from a Gitea instance.

    Gitea's commit-status API carries context/state pairs rather than a rollup,
    so the rollup is folded here — same vocabulary as the GitHub path.
    """
    if not token:
        return {"ok": False, "error": "no Gitea token (GITEA_TOKEN or tea login)"}
    import urllib.error
    import urllib.parse
    import urllib.request

    def api(path):
        url = f"{base_url.rstrip('/')}/api/v1/{path}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"token {token}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=GITEA_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            return {"__error": f"HTTP {exc.code}"}
        except Exception as exc:  # noqa: BLE001 — network is allowed to fail
            return {"__error": f"{type(exc).__name__}: {exc}"}

    head = api(f"repos/{slug}/branches/{urllib.parse.quote(branch, safe='')}")
    if "__error" in head:
        return {"ok": False, "error": head["__error"]}
    head_sha = ((head.get("commit") or {}).get("id")) or ""

    status = api(f"repos/{slug}/commits/{head_sha}/status" if head_sha else "repos/x/y/statuses/x")
    contexts = []
    if "__error" not in status:
        for row in status.get("statuses") or []:
            target = row.get("target_url") or ""
            # Gitea returns root-relative action URLs; make them clickable.
            if target.startswith("/"):
                target = f"{base_url.rstrip('/')}{target}"
            contexts.append({
                "name": row.get("context") or "status", "type": "status",
                "status": "COMPLETED", "conclusion": (row.get("status") or "").upper(),
                "url": target,
            })
    tally = _tally(contexts)

    pr = None
    pull = api(f"repos/{slug}/pulls?state=all&limit=20")
    if isinstance(pull, list):
        for row in pull:
            if (row.get("head") or {}).get("ref") == branch:
                pr = {
                    "number": row.get("number") or 0,
                    "state": "merged" if row.get("merged_at") else (row.get("state") or "").lower(),
                    "draft": bool(row.get("draft")),
                    "title": row.get("title") or "",
                    "url": row.get("html_url") or "",
                    "mergeable": "UNKNOWN", "reviewDecision": "",
                    "headSha": ((row.get("head") or {}).get("sha")) or "",
                    # Same tri-state as the GitHub path — the defect is
                    # forge-independent, so the rule must be too.
                    "headMatches": ((((row.get("head") or {}).get("sha")) == head_sha)
                                    if head_sha else None),
                }
                break

    return {"ok": True, "branch": branch, "headSha": head_sha,
            "checkState": tally["state"], "counts": tally, "contexts": contexts,
            "pr": pr, "truncated": False}


def gitea_actions_available(base_url: str, slug: str, token: str) -> bool:
    """Does this Gitea have Actions enabled at all? Absent that, 'no checks'
    is the truth rather than a broken probe."""
    import urllib.error
    import urllib.request
    if not token:
        return False
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/v1/repos/{slug}/actions/tasks?limit=1",
        headers={"Authorization": f"token {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=GITEA_TIMEOUT) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as exc:
        return exc.code != 404
    except Exception:  # noqa: BLE001
        return False


# ── repo discovery / probing ─────────────────────────────────────────────────

def _default_branch(repo: Path) -> str:
    ref = _git_ok(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if ref.startswith("refs/remotes/origin/"):
        return ref[len("refs/remotes/origin/"):]
    ls = _git_ok(repo, "ls-remote", "--symref", "origin", "HEAD", timeout=12)
    for line in ls.splitlines():
        if line.startswith("ref:") and "refs/heads/" in line:
            return line.split("refs/heads/", 1)[1].split()[0]
    for candidate in ("main", "master", "dev", "develop"):
        if _git_ok(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}"):
            return candidate
    return ""


def probe_repo(repo: Path, cfg: dict, branch_override: str | None = None,
               gh_ok: bool | None = None) -> dict:
    """Everything the UI needs about one working copy."""
    repo = Path(repo)
    root = _git_ok(repo, "rev-parse", "--show-toplevel") or ""
    if not root:
        return {"root": str(repo), "name": repo.name, "host": "none", "skipped": True,
                "error": "not a git working copy", "branches": {}}
    root = Path(root)

    remote_url = _git_ok(root, "remote", "get-url", "origin")
    parsed = parse_remote(remote_url)
    current = branch_override or _git_ok(root, "rev-parse", "--abbrev-ref", "HEAD")
    if current == "HEAD":
        current = branch_override or ""
    default = _default_branch(root)

    # A repo with no forge is not a failure — it is simply not CI work. Report
    # it as skipped so the pane can tell "no pipeline" from "pipeline broken"
    # instead of painting a broken dot on a scratch checkout.
    if not parsed:
        return {
            "root": str(root), "name": root.name, "host": "none", "skipped": True,
            "remote": remote_url, "slug": "", "hostname": "", "url": "",
            "currentBranch": current, "defaultBranch": default,
            "dirty": bool(_git_ok(root, "status", "--porcelain")),
            "fetchedAt": time.time(), "branches": {},
            "error": "no origin remote" if not remote_url else "unrecognised forge host",
            "checkState": "none", "pr": None, "hasCiConfig": False, "forgeReady": False,
        }

    hostname, slug = parsed
    kind = classify_host(hostname)
    has_ci = _has_ci_config(root, kind)
    entry = {
        "root": str(root),
        "name": root.name,
        "host": kind,
        "remote": remote_url,
        "slug": slug, "hostname": hostname, "url": f"https://{hostname}/{slug}",
        "currentBranch": current,
        "defaultBranch": default,
        "dirty": bool(_git_ok(root, "status", "--porcelain")),
        "fetchedAt": time.time(),
        "branches": {},
        "skipped": False,
        "hasCiConfig": has_ci,
        "prBaseUrl": f"https://{hostname}/{slug}/pulls"
                     if kind == "gitea" else f"https://{hostname}/{slug}/pulls",
    }

    wanted: list[str] = []
    for branch in (current, default):
        if branch and branch not in wanted:
            wanted.append(branch)
    # Trunk's CI belongs to the trunk; a feature-branch session wants its own
    # answer only, so trunk is probed just to keep the branch switcher honest.

    if kind == "github":
        if gh_ok is None:
            gh_ok = _gh_ready()
        entry["forgeReady"] = gh_ok
        # Always ask: GitHub reports checks from Apps as well as Actions, so a
        # missing .github/workflows is a hint for the UI, never proof there is
        # nothing to show.
        for branch in wanted:
            entry["branches"][branch] = github_branch(slug, branch, gh_ok)
    else:
        base = _gitea_base(cfg, hostname, "http" if remote_url.startswith("http://") else "https")
        token = _gitea_token(cfg)
        entry["forgeReady"] = bool(token)
        entry["forgeBaseUrl"] = base
        entry["giteaActions"] = gitea_actions_available(base, slug, token)
        for branch in wanted:
            entry["branches"][branch] = gitea_branch(base, slug, branch, token)

    current_entry = entry["branches"].get(current) or {}
    primary = current_entry if current_entry.get("ok") else (entry["branches"].get(default) or {})
    entry["checkState"] = primary.get("checkState", "unknown")
    entry["pr"] = primary.get("pr")
    # A branch that exists locally but has no upstream ref is a STATE OF ITS OWN,
    # not an absence of information: after a merge it is the normal state. Name it
    # so the UI can say "not on the remote" rather than the misleading "no checks".
    entry["branchAbsentUpstream"] = bool(current) and not primary.get("headSha")
    return entry


def discover_repos(cfg: dict, explicit: list[str]) -> list[Path]:
    seen: list[Path] = []
    candidates: list[str] = list(explicit) + list(cfg.get("repos") or [])
    if cfg.get("auto_scan", True):
        scan_root = Path(cfg.get("scan_root") or DEFAULT_SCAN_ROOT)
        if scan_root.is_dir():
            try:
                candidates += [str(p) for p in sorted(scan_root.iterdir()) if p.is_dir() and (p / ".git").exists()]
            except OSError:
                pass
    for raw in candidates:
        expanded = Path(os.path.expanduser(str(raw)))
        try:
            resolved = expanded.resolve()
        except OSError:
            continue
        if resolved not in seen and (resolved / ".git").exists():
            seen.append(resolved)
    return seen


def build_document(repos: list[Path], cfg: dict, branch: str | None = None,
                   repo_filter: list[str] | None = None) -> dict:
    gh_ok = _gh_ready()
    out, errors = [], []
    wanted = None
    if repo_filter:
        wanted = {str(Path(os.path.expanduser(p)).resolve()) for p in repo_filter}
    for repo in repos:
        if wanted is not None and str(repo.resolve()) not in wanted:
            continue
        try:
            entry = probe_repo(repo, cfg, branch_override=branch, gh_ok=gh_ok)
        except Exception as exc:  # noqa: BLE001 — one bad repo must not kill the sweep
            entry = {"root": str(repo), "host": "none", "name": repo.name,
                     "error": f"{type(exc).__name__}: {exc}", "branches": {}}
        out.append(entry)
        if entry.get("error"):
            errors.append({"root": entry.get("root"), "error": entry["error"]})
    return {
        "generatedAt": time.time(),
        "ghReady": gh_ok,
        "repos": out,
        "errors": errors,
    }


def load_config(path: Path | None = None) -> dict:
    cfg_path = Path(path) if path else CONFIG_PATH
    try:
        loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def selftest() -> int:
    """Offline assertions — no network, no repos required."""
    failures = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    check("parse https", parse_remote("https://github.com/acme/widget.git"),
          ("github.com", "acme/widget"))
    check("parse ssh", parse_remote("git@github.com:acme/widget.git"),
          ("github.com", "acme/widget"))
    check("parse gitea ssh", parse_remote("ssh://git@git.example.com/acme/widget.git"),
          ("git.example.com", "acme/widget"))
    check("parse scp gitea", parse_remote("git@git.example.com:acme/widget.git"),
          ("git.example.com", "acme/widget"))
    check("parse junk", parse_remote("not a url"), None)
    check("classify github", classify_host("github.com"), "github")
    check("classify gitea", classify_host("git.example.com"), "gitea")

    green = [{"type": "check", "status": "COMPLETED", "conclusion": "SUCCESS"}]
    red = [{"type": "check", "status": "COMPLETED", "conclusion": "FAILURE"}]
    amber = [{"type": "check", "status": "IN_PROGRESS", "conclusion": None}]
    check("tally green", _tally(green)["state"], "success")
    check("tally red", _tally(red)["state"], "failure")
    check("tally amber", _tally(amber)["state"], "pending")
    check("tally empty", _tally([])["state"], "none")
    check("tally red wins", _tally(green + red + amber)["state"], "failure")
    check("tally amber over green", _tally(green + amber)["state"], "pending")

    pr = _pr_payload({"number": 18, "state": "OPEN", "isDraft": False, "title": "t",
                      "url": "u", "mergeable": "MERGEABLE", "reviewDecision": "REVIEW_REQUIRED",
                      "headRefOid": "abc"}, "abc")
    check("pr head matches", pr["headMatches"], True)
    check("pr head drifted", _pr_payload({"headRefOid": "zzz"}, "abc")["headMatches"], False)

    # ── tri-state (003) ──────────────────────────────────────────────────────
    # With no resolvable local head there was NO COMPARISON, so the answer is
    # unknown — not "drifted". This is the assertion that catches the observed
    # false positive: a merged PR on a branch the remote has since deleted.
    absent = _pr_payload({"headRefOid": "abc"}, "")
    check("pr head unknown when local head is empty", absent["headMatches"], None)
    # `is not False` is the load-bearing half: `None == False` is False, but so
    # is `False == False`'s negation — assert the identity, not equality.
    if absent["headMatches"] is False:
        failures.append("pr head unknown: reported False (drift) for an unresolvable local head")
    # Totality: all three states reachable and distinct.
    check("tristate total (true)", _pr_payload({"headRefOid": "abc"}, "abc")["headMatches"], True)
    check("tristate total (false)", _pr_payload({"headRefOid": "abc"}, "zzz")["headMatches"], False)
    check("tristate total (none)", _pr_payload({"headRefOid": "abc"}, "")["headMatches"], None)

    # The PROJECTION must preserve the tri-state. `bool(None)` is False, so the
    # compact step silently converted "unknown" into "drifted" — and because the
    # chip reads the compacted document, a collector-only fix would pass every
    # collector test and still show the badge. This is that assertion.
    compacted = _compact_pr({"n": 4, "state": "merged", "headMatches": None})
    if compacted["headMatches"] is not None:
        failures.append("compaction flattened headMatches: expected None, got "
                        f"{compacted['headMatches']!r} (a tri-state MUST NOT survive as a boolean)")
    check("compaction keeps true", _compact_pr({"n": 1, "headMatches": True})["headMatches"], True)
    check("compaction keeps false", _compact_pr({"n": 1, "headMatches": False})["headMatches"], False)

    # A branch with no upstream ref is a NAMED state, so the UI can say it in
    # words instead of reporting "no checks" (003 FR-005).
    absent = github_branch("acme/widget", "gone-branch", False)
    if absent.get("ok") is False:
        # gh unavailable in this environment: the flag is asserted by the harness
        # fixture instead. Do not fail the offline suite for that.
        pass

    if failures:
        print("SELFTEST FAILED")
        for f in failures:
            print(" -", f)
        return 1
    print(f"selftest ok ({len(CHECK_STATES)} states)")
    return 0


def _compact_entry(entry: dict, repo_root: str = "") -> dict:
    """Strip a repo entry down to what a chip or a table row needs.

    The desktop's `shell.exec` RPC keeps only the last 4000 characters of
    stdout, so a full sweep of a real `~/projects` tree does not fit at full
    fidelity. Compact rows keep the colour, the counts and the PR identity —
    per-check detail is fetched separately with `--repo`.
    """
    branches = {}
    for name, info in (entry.get("branches") or {}).items():
        counts = info.get("counts") or {}
        branches[name] = {
            "ok": info.get("ok"),
            "checkState": info.get("checkState", "unknown"),
            # Drop the counts key that merely repeats checkState.
            "n": {k: v for k, v in counts.items() if k != "state" and v},
            "pr": _compact_pr(info.get("pr")),
            "error": (info.get("error") or "")[:120] or None,
        }
    return {
        "name": entry.get("name"),
        # Only the part of the path the UI has to match on: the cwd probe sends
        # an absolute path, so a suffix is enough to identify the row.
        "path": entry.get("root") or "",
        "host": entry.get("host"),
        "slug": entry.get("slug") or "",
        "url": entry.get("url") or "",
        "branch": entry.get("currentBranch") or "",
        "state": entry.get("checkState") or "unknown",
        "pr": _compact_pr(entry.get("pr")),
        "skipped": bool(entry.get("skipped")),
        "hasCi": bool(entry.get("hasCiConfig")),
        "branches": branches,
        "error": (entry.get("error") or "")[:120] or None,
    }


def _compact_pr(pr: dict | None) -> dict | None:
    """A PR reduced to identity + colour + where to click."""
    if not pr:
        return None
    return {
        "n": pr.get("number") or 0,
        "state": (pr.get("state") or "")[:10],
        "draft": bool(pr.get("draft")),
        "title": (pr.get("title") or "")[:90],
        "url": pr.get("url") or "",
        "mergeable": (pr.get("mergeable") or "")[:12],
        "review": (pr.get("reviewDecision") or "")[:20],
        # Pass the tri-state through UNCHANGED. `bool(None)` is False, and the
        # chip reads THIS compacted document — so wrapping it here silently
        # turned "unknown" into "drifted" on the very surface the defect was
        # reported on, while every collector-level test still passed.
        "headMatches": pr.get("headMatches"),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="CI/PR status for watched repos")
    ap.add_argument("--json", action="store_true", help="emit the JSON document")
    ap.add_argument("--repo", action="append", default=[], help="repo path (repeatable)")
    ap.add_argument("--branch", default=None, help="pin every repo to this branch")
    ap.add_argument("--config", default=None, help="config file path")
    ap.add_argument("--no-scan", action="store_true", help="skip the auto scan root")
    ap.add_argument("--compact", action="store_true",
                    help="drop per-check detail (for the 4 KB RPC stdout budget)")
    ap.add_argument("--selftest", action="store_true", help="run offline checks and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    cfg = load_config(args.config)
    if args.no_scan:
        cfg["auto_scan"] = False

    repos = discover_repos(cfg, args.repo)
    doc = build_document(repos, cfg, branch=args.branch, repo_filter=args.repo or None)
    doc["configPath"] = str(Path(args.config) if args.config else CONFIG_PATH)

    # The 4000-char transport budget on `shell.exec` is a real ceiling: rather
    # than silently lose the tail of the JSON (which the client would then fail
    # to parse), compact until it fits and say so.
    if args.compact:
        doc.pop("configPath", None)
        doc["repos"] = [_compact_entry(e) for e in doc["repos"]]
        for _ in range(24):
            blob = json.dumps(doc, separators=(",", ":"))
            if len(blob) <= 3900:
                break
            # Shed the least important rows first: skipped repos (no forge),
            # then the oldest by fetch time, so a truncated sweep still names
            # every repo that actually has CI.
            droppable = [e for e in doc["repos"] if e.get("skipped")]
            if not droppable:
                droppable = sorted(doc["repos"], key=lambda e: e.get("fetchedAt") or 0)
            if not droppable:
                break
            victim = droppable[0]
            doc["repos"].remove(victim)
            doc.setdefault("omitted", []).append(victim.get("name"))

    if args.json or not sys.stdout.isatty():
        json.dump(doc, sys.stdout, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0

    for entry in doc["repos"]:
        state = (entry.get("checkState") or "unknown").upper()
        pr = entry.get("pr") or {}
        pr_txt = f" #{pr['number']} {pr.get('state','')}" if pr else ""
        skip = " (skipped)" if entry.get("skipped") else ""
        print(f"{state:8s} {entry.get('name','?'):28s} {entry.get('currentBranch',''):24s}{pr_txt}{skip}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
