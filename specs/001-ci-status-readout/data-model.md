# Data Model: CI Status Readout

**Feature**: `001-ci-status-readout` | **Baseline of `main` @ `f46c299`**

The whole contract is **one JSON document** emitted by the collector. The plugin renders it; the
harness asserts it. Nothing is persisted on either side except the plugin's stored collector command.

## Document (top level)

| Field | Type | Meaning |
| --- | --- | --- |
| `generatedAt` | float (epoch seconds) | when the sweep ran |
| `ghReady` | bool | whether the GitHub CLI is installed **and** authenticated |
| `repos` | array of RepoEntry | one per watched working copy |
| `errors` | array of `{root, error}` | repositories that raised during their probe |
| `configPath` | string | the config file the collector read (omitted in compact mode) |
| `omitted` | array of string (compact only) | names shed to fit the transport budget |

## RepoEntry

| Field | Type | Meaning |
| --- | --- | --- |
| `root` | string | absolute path of the working copy |
| `name` | string | basename of `root` |
| `host` | `"github" \| "gitea" \| "none"` | forge classification from the remote |
| `remote` | string | the `origin` URL |
| `slug` | string | `owner/name` parsed from the remote |
| `hostname` | string | host part of the remote |
| `url` | string | `https://<hostname>/<slug>` |
| `currentBranch` | string | the branch the checkout is on (or `""` when detached) |
| `defaultBranch` | string | the remote's default branch |
| `dirty` | bool | whether the working tree has changes |
| `branches` | map<branch, BranchResult> | current and default branch results |
| `skipped` | bool | true when there is no forge (a scratch checkout) |
| `hasCiConfig` | bool | whether the checkout carries CI workflow files |
| `forgeReady` | bool | whether the forge credentials are usable |
| `checkState` | RAG state | the state of the current branch (or default as fallback) |
| `pr` | PullRequest \| null | the current branch's PR |
| `error` | string \| null | why this repo is skipped or broken |
| `giteaActions` | bool | (Gitea only) whether Actions is enabled at all |
| `forgeBaseUrl` | string | (Gitea only) the resolved API base |

## BranchResult

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | bool | whether the forge answered |
| `branch` | string | the branch this result is for |
| `headSha` | string | the commit the checks belong to |
| `checkState` | RAG state | the folded state |
| `counts` | `{state,total,passed,failed,pending,skipped,neutral}` | the fold |
| `contexts` | array of CheckContext | the individual checks (full mode only) |
| `pr` | PullRequest \| null | the branch's PR |
| `truncated` | bool | whether the status list was cut by the API |
| `error` | string | the forge error, when `ok` is false |
| `n` | map (compact only) | counts with zero-values and the redundant `state` dropped |

### RAG states (total vocabulary)

`success` · `failure` · `pending` · `neutral` · `none` · `unknown`

**Fold rule (load-bearing):** `failure` and `pending` **beat** `success`. An empty check list folds to
`none`; a non-empty list with no failures and no pending folds to `success`; otherwise `neutral`.

## CheckContext

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | the check/job name |
| `type` | `"check" \| "status"` | a job-level check, or a legacy commit status |
| `status` | string | `COMPLETED`, `IN_PROGRESS`, `QUEUED`, … |
| `conclusion` | string \| null | `SUCCESS`, `FAILURE`, `SKIPPED`, … |
| `url` | string | link to the run |

## PullRequest

| Field | Type | Meaning |
| --- | --- | --- |
| `number` / `n` | int | PR number |
| `state` | string | `open`, `merged`, `closed` |
| `draft` | bool | draft flag |
| `title` | string | title (truncated in compact mode) |
| `url` | string | the PR page |
| `mergeable` | string | `MERGEABLE` / `CONFLICTING` / `UNKNOWN` |
| `reviewDecision` / `review` | string | `REVIEW_REQUIRED`, `APPROVED`, … |
| `headSha` | string | the PR's head commit |
| `headMatches` | bool | whether that head equals the local checkout's head |

## Relationships

```
Document 1─* RepoEntry 1─* BranchResult 1─* CheckContext
                              └─0..1 PullRequest
```

## State Transitions / Derivations

- `RepoEntry.checkState` = the current branch's state when its probe succeeded, else the default
  branch's.
- `headMatches === false` ⇔ the UI shows **sha drift** (the checks belong to a later commit).
- A repo is **watched** iff it has a resolvable forge remote; otherwise it is `skipped` and grouped
  separately in the UI.
