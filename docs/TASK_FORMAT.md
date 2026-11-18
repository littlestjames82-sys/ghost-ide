# GhostIDE task records: the `ghostide.task` format, version 1

Mobile Cycle 3 (S1) defines ONE portable record for a unit
of agent work, written and read identically by the desktop
server (`server.py`) and the phone server (`IdeServer.java`).
A task record is the substrate the supervision work (M2)
and the desktop pairing client (M10) will read. This
document is the single definition; the two implementations
mirror it, and a shared fixture
(`tests/fixtures/task_record_v1.json`) proves they agree.

A task record is DATA. It is shape-checked and stored
verbatim, never executed and never interpreted beyond the
summary fields the list view reads. It describes work; it
does not resume work. Resuming a live run from a record is
M2's job, and the UI says so wherever a record is shown.

## Where records live

- On disk: `.ghostide/tasks/<id>.json` in the workspace,
  one JSON object per file, written atomically (temp file
  plus rename), next to the D2 stores (`.ghostide/plans/`,
  `.ghostide/checkpoints/`, `.ghostide/agent-runs/`).
- Over HTTP, in the house shapes:
  - `GET /api/tasks` lists summaries
    (`{"tasks": [...]}`), newest update first, at most 100.
  - `GET /api/tasks?id=<id>` returns `{"record": {...}}`,
    or 404 `{"error": "no such task record"}`.
  - `POST /api/tasks` creates one record. A body over the
    size cap is refused before parsing (413). Creating an
    id that already exists is refused (409,
    `{"error": "a task record with this id already exists; update it instead"}`).
  - `POST /api/tasks/update` replaces an existing record;
    a missing id is a 404 with the same "no such task
    record" error.
  - Validation failures are 400 with a named error (see
    below). Exactly like the D2 run records, these routes
    are not trust-gated: writing a record is a plain
    workspace file write of data, and the trust gate covers
    routes that execute code or drive tools.

## The record

```json
{
  "schema": "ghostide.task",
  "schemaVersion": 1,
  "id": "task-20261118-174500-x7k2p9",
  "kind": "agent-run",
  "title": "Fix the parser crash",
  "goal": "Fix the parser crash in src/parse.py",
  "workspace": "/home/ryan/project",
  "createdBy": "desktop",
  "status": "done",
  "budget": { "stepCap": 50 },
  "approvals": { "asked": 2, "allowed": 2, "denied": 0 },
  "checkpoint": ".ghostide/checkpoints/ckpt-run-20261118-174500-x7k2p9.json",
  "planPath": null,
  "steps": { "count": 4, "lastLabel": "edit src/parse.py" },
  "createdAt": "2026-11-18T17:45:00",
  "updatedAt": "2026-11-18T17:46:12",
  "payload": { "runId": "run-20261118-174500-x7k2p9" }
}
```

### Fields

| Field | Type | Rules |
|---|---|---|
| `schema` | string | Required. Exactly `"ghostide.task"`. |
| `schemaVersion` | integer | Required. This document defines `1`. |
| `id` | string | Required. `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, never containing `..` (the house id rule, shared with run records). The file name is `<id>.json`. |
| `kind` | string | Required. One of `agent-run`, `plan`, `note`. |
| `title` | string | Required. 1 to 200 characters. |
| `goal` | string | Required (may be empty for a `note`). At most 20000 characters. The prompt or goal text the work was given. |
| `workspace` | string | Required. At most 1000 characters. The workspace path as the writing platform records it; the phone build records `on-device`. It is provenance, not a path either server resolves. |
| `createdBy` | string | Required. `desktop` or `android`: the platform that created the record. Importing a record never rewrites this; see `provenance`. |
| `status` | string | Required. One of `draft`, `running`, `waiting-approval`, `stopped`, `done`, `failed`. Status is data mirroring the run's real state at write time; nothing in S1 moves a record between states on its own. |
| `budget` | object | Required. `{ "stepCap": <int 0..100000> }`: the agent step cap in force for the work (0 for a note with no run). |
| `approvals` | object | Required. `{ "asked": int, "allowed": int, "denied": int }`, counts at or above 0: the approvals summary of what the approval policy did during the run. Verdicts `allowed`, `auto` and `granted` count as allowed; `denied` and `disabled` count as denied; every recorded approval counts as asked. |
| `checkpoint` | string or null | Optional. The D2 run checkpoint reference (`.ghostide/checkpoints/ckpt-<run id>.json`) when one exists, else null. At most 1000 characters. |
| `planPath` | string or null | Optional. The D2 plan file (`.ghostide/plans/plan-<stamp>.md`) when one exists, else null. At most 1000 characters. |
| `steps` | object | Required. `{ "count": <int at or above 0>, "lastLabel": <string, at most 300 characters> }`: how many steps the work took and what the last one did (`"<type> <target>"`, or empty). |
| `createdAt` | string | Required. ISO 8601 seconds (`YYYY-MM-DDTHH:MM:SS`, with optional fractional seconds and zone), the house timestamp shape. |
| `updatedAt` | string | Required. Same shape; when the record was last written. |
| `provenance` | object | Optional, written only by an import: `{ "importedFrom": { "id": <original id>, "platform": <original createdBy>, "at": <timestamp> } }`. |
| `payload` | object | Optional. Free-form forward-compatible data. Run-derived records carry `runId` (the D2 run record id), `outcome` (the run's raw outcome word), `summary`, `filesChanged` and `skipped` here. |

Unknown top-level fields are allowed and preserved
verbatim: a version 1 reader must not strip what a later
version 1 writer added. Only a higher `schemaVersion`
changes the contract, and that is refused (below).

### Run outcome to task status

Run-derived records map the D2 run outcome onto `status`
(the raw word is kept in `payload.outcome`):

| Run outcome | Task status |
|---|---|
| `done`, `asked` | `done` |
| `failed` | `failed` |
| `stopped`, `cap`, `looping` | `stopped` |
| anything else | `failed` |

(`cap` and `looping` are stops imposed by the budget and
the stuck detector, not failures of the work.)

## Validation (shared, strict, named)

Both implementations run the same checks in the same
order and refuse with the same words:

1. Body over 262144 bytes (256 KB, the house record cap):
   `task record too large (limit 262144 bytes)`.
2. Not a JSON object: `task record must be a JSON object`.
3. `schema` is not `"ghostide.task"`:
   `not a GhostIDE task record`.
4. `schemaVersion` missing or not an integer:
   `task record has no readable schema version`.
5. `schemaVersion` greater than 1:
   `task record was written by a newer GhostIDE (task schema version N); this build reads version 1`.
   The record is refused whole, never silently mangled.
6. `schemaVersion` below 1:
   `task record schema version N is older than any this build can read`.
7. Bad `id`: `bad task id`.
8. Bad `kind`: `task record kind must be one of agent-run, plan, note`.
9. Bad `title`: `task record title must be a string of 1 to 200 characters`.
10. Bad `goal`: `task record goal must be a string of at most 20000 characters`.
11. Bad `workspace`: `task record workspace must be a string of at most 1000 characters`.
12. Bad `createdBy`: `task record createdBy must be desktop or android`.
13. Bad `status`: `task record status must be one of draft, running, waiting-approval, stopped, done, failed`.
14. Bad `budget`: `task record budget.stepCap must be an integer from 0 to 100000`.
15. Bad `approvals`: `task record approvals must be an object with asked, allowed and denied counts at or above 0`.
16. Bad `steps`: `task record steps must be an object with a count at or above 0 and a lastLabel string of at most 300 characters`.
17. Bad `checkpoint` or `planPath`:
    `task record checkpoint must be a string of at most 1000 characters or null`
    (same words with `planPath`).
18. Bad timestamps:
    `task record createdAt must be an ISO 8601 timestamp string`
    (same words with `updatedAt`).
19. Bad `provenance` or `payload`:
    `task record provenance must be an object` /
    `task record payload must be an object`.

## Export and import

A record exports as itself: the single JSON file is the
whole export, nothing else is needed to read it anywhere.

Importing keeps the record unchanged except identity:
the importing side mints a fresh local id and records the
mapping in the copy:

```json
"provenance": {
  "importedFrom": {
    "id": "task-20261118-174500-x7k2p9",
    "platform": "desktop",
    "at": "2026-11-18T18:02:00"
  }
}
```

`createdBy` still names the platform that created the
work; `provenance.importedFrom` names where this copy
came from. An import that would collide with an existing
local id is impossible by construction (the id is fresh).

## Canonical form (the portability proof)

Two implementations agree on a record when they agree on
its canonical form: JSON with object keys sorted, no
insignificant whitespace, strings escaped only where JSON
requires it (quote, backslash, control characters), and
integral numbers written without a decimal point. The
shared fixture `tests/fixtures/task_record_v1.json` and
its expected canonical form
`tests/fixtures/task_record_v1.canonical.txt` are consumed
by both test suites (Python and JVM): each implementation
validates the fixture, and its canonical form of the
fixture, and of the fixture after a store-and-read
round-trip, must equal the expected string byte for byte.

## What S1 is not

- Not supervision (M2): no background running, no
  notifications, no resuming. A stored `running` status is
  a snapshot word, not a live run.
- Not pairing (M10): no transport. Export and import move
  one file by hand; nothing syncs.
- Not a session format: chat history, open tabs and drafts
  stay where they already live (device-local storage on
  both platforms, restored on launch). The task record is
  the portable piece; the session is not yet.
