# Engineering decisions

The brief describes a coordination problem more than a CRUD problem: work goes missing, two people pick up the same thing, edits collide, decisions aren't traceable. I prioritised **correctness under concurrent use and a trustworthy history** over feature breadth, and kept the system small enough to explain fully.

The assumptions I made are listed at the end.

---

## 1. Optimistic concurrency with versions, plus atomic claims — not locks

**Decision.** Every work item has a `version`. Every change that depends on what the user saw (edit, assign, release, workflow move) must send `expectedVersion`, and the update is a single conditional statement:

```sql
UPDATE work_items SET …, version = version + 1 WHERE id = ? AND version = ?
```

Zero rows changed means someone else got there first; the server returns `409 VERSION_CONFLICT` with the current item **and the list of changes since your version** (who changed which field, from what, to what).

Claiming is different. When someone takes an unassigned item, what matters is "is it still unassigned?", not "is it unchanged?" — a colleague adding a comment or bumping priority shouldn't make your claim fail. So claim uses its own condition:

```sql
UPDATE work_items SET assignee_id = ? … WHERE id = ? AND assignee_id IS NULL AND status IN (...)
```

Exactly one concurrent claimer wins; the others get `409 ALREADY_CLAIMED` naming the winner. Re-claiming your own item is a no-op success, so retries are harmless.

**On the client** the edit form remembers the version it started from. If a live update shows a newer version while you're typing, a banner tells you which fields changed. On save:
- if the other person changed **different fields**, the client re-sends only *your* changed fields against the new version — a safe field-level merge;
- if you both changed **the same field**, you choose per field (*keep theirs / keep mine*). Nothing is overwritten without a human deciding.

**Why not pessimistic locks ("Chen is editing…")?** Locks need expiry, break when tabs close, and block people during incidents — exactly when several people need to touch the same item. Conflicts are rare; optimistic concurrency costs nothing until one happens and then gives the user the information to resolve it.

**Trade-offs.** Users occasionally see a conflict prompt. Comments deliberately do *not* bump the version, so discussion never causes edit conflicts. The guard lives in the `WHERE` clause rather than in a read-then-check, so it stays correct under any isolation level and with several app servers — it ports to Postgres unchanged.

---

## 2. One transaction per action: the change, its history, its side effects and its idempotency record

**Decision.** Each command writes, atomically:
1. the change to `work_items`,
2. an append-only `activity` row (who, what, old → new values, resulting version),
3. a `jobs` row for asynchronous follow-up (the *transactional outbox*),
4. the stored response for its `Idempotency-Key`, if one was sent.

**Why.** The brief's core complaint is that important things silently disappear and nobody knows why a decision was made. If the history were written separately (or by the async worker), a crash between the two would produce an item whose history is wrong. Writing the outbox row in the same transaction means a notification is never sent for a change that rolled back, and never lost for one that committed.

**Idempotency.** Mutations accept an `Idempotency-Key` header. The client creates one key per *user intent* (one per form, one per comment, one per button press) and reuses it for automatic retries. The key's stored response commits with the change, so:
- retry after a dropped connection → the original response is replayed, nothing runs twice;
- same key, different body → `422 IDEMPOTENCY_KEY_REUSED` (a client bug; refuse to guess);
- failed requests aren't stored, so the retry is evaluated fresh.

Keys are scoped per user and expire after 24 h. Natural idempotency is used where it's free (claim, mark-notifications-read).

**Trade-offs.** Slightly larger write transactions; `activity` grows without bound (that's the point — it's the audit log; at scale I'd partition it by month).

---

## 3. Authorization is per team, enforced in one policy module, and invisible items are 404

**Decision.** Users belong to teams with a role per team — **viewer** (read, comment), **member** (create, edit, claim, work items through the workflow), **lead** (assign others, approve, close, reopen, change approval requirements). Global admins act as lead everywhere. All rules live in `authz.js` and `workflow.js`; route handlers never make permission decisions.

- Every read and write loads the item through `getVisible()`, which returns **404** if the item's team isn't one of yours — the same answer as a non-existent item, so IDs can't be probed.
- List, search, counts and the SSE stream are all scoped to the caller's teams *in the query itself*, not filtered afterwards.
- Workflow edges declare who may take them (`assignee or lead`, `lead`, `reporter or lead`, …). Approval enforces **separation of duties**: a lead cannot approve work assigned to themselves.
- Assignees must be members/leads of the item's team; members can assign only themselves (by claiming).
- Permissions are re-read from the database on every request, so removing someone from a team takes effect immediately (tested).
- The API returns a `permissions` object with each item so the UI can hide impossible actions — but that is a convenience; the server re-checks everything (tests call the API directly as viewers/outsiders).

**Why per-team roles rather than global roles?** Responsibility in the brief is organised by team; a person can be a lead in Payments and a member in Support. A global role can't express that.

**Trade-offs.** No per-item ACLs or cross-team sharing; moving an item between teams isn't supported yet. Payment and compliance items require approval by default (a lead can change that per item).

---

## 4. Async work through a leased outbox, assuming at-least-once delivery

**Decision.** Notifications are produced by a worker that reads the `jobs` table:

- **Claiming is atomic**: a conditional `UPDATE` moves a job to `processing` with a 30-second lease. Two workers can never run the same job at once.
- **Crash-safe**: if a worker dies mid-job, the lease expires and another worker picks it up.
- That makes delivery **at-least-once**, so handlers must be idempotent. Notifications have `UNIQUE(user_id, activity_id)` and are inserted with `INSERT OR IGNORE`; running a job twice changes nothing (tested by forcing redelivery).
- Each job runs in its own transaction: a handler that fails half-way leaves no partial notifications.
- Failures retry with exponential backoff (1 s → 60 s); after 5 attempts the job is marked **dead** with its last error, kept for inspection rather than dropped.
- Jobs may run late, so handlers use the facts recorded in the event (e.g. who was assigned *at creation*) rather than the item's state at processing time — a test caught exactly this bug.

**What is synchronous and what isn't.** Everything a user needs to trust immediately — the change, its permission check, the workflow rule, the history entry — is synchronous. Only fan-out (who should hear about it) is asynchronous. A slow or broken notification path can never block or fail someone's action.

**Trade-offs.** The worker polls every 500 ms (adds up to half a second of notification latency). It runs inside the API process for one-command startup but only coordinates through the database, so `npm --prefix server run worker` runs it separately and several can run at once.

---

## 5. Live updates by tailing the committed activity log, and lists that don't move under your cursor

**Decision.** Each server process tails the `activity` table and pushes small events (`itemId`, `version`, actor) over Server-Sent Events to connected users who can see that team. Clients then refetch through the normal authorized API.

**Why tail the table instead of publishing from request handlers?**
- Only committed changes are announced — never something that later rolled back.
- It works across several server processes with no extra infrastructure.
- Reconnecting browsers send `Last-Event-ID` and receive what they missed.
- Events carry no item content, so SSE can't become a second, weaker authorization path.

**UX choice.** The item you're looking at refreshes immediately (and drives the "changed while you were editing" banner). Counts refresh in coalesced batches. **Lists do not reorder automatically**: they show "*N changes by others since this list loaded — Refresh*". In a busy queue, rows jumping around right before you click is how people open the wrong item.

**Trade-offs.** SSE is one-way, which is all that's needed (writes go through the API). Polling the table costs one indexed query per process per 400 ms; at larger scale I'd switch to Postgres `LISTEN/NOTIFY` or Redis pub/sub with the same event shape.

---

## 6. Keyset pagination, indexes shaped around the questions people ask, and FTS search

**Decision.** The browser never loads the dataset. Lists are served 50 rows at a time with an opaque cursor encoding the sort key and id (`(priority, updated_at, id) < (…)`), so page 200 costs the same as page 1, and inserts/edits between page loads can't cause skipped or repeated rows the way `OFFSET` does (tested with deliberate timestamp ties). Every sort has `id` as a tie-breaker.

Indexes follow the actual queries: team scope first, then status, then the sort key. The most common question ("active work, most urgent first") has **partial indexes** over active statuses; the query writes that status list literally so SQLite can prove the partial index applies — this took "admin: active by priority" at 100k items from 104 ms to 4 ms. Search uses SQLite **FTS5** over title and description with prefix matching (input is tokenised and quoted, so user text can't inject FTS syntax), and `PAY-123` / `#123` jump straight to an item.

"What needs attention" is first-class: the dashboard and saved views answer *mine*, *unassigned P1–P2*, *awaiting my approval*, *overdue*, *blocked*. Items get a due time from their priority (P1: 4 h, P2: 1 day, P3: 3 days, P4: 7 days) unless one is given, which is what makes "overdue" meaningful.

**Trade-offs.** No arbitrary jump-to-page. Totals are computed only for the first page. I chose porter-free tokenisation because stemming breaks prefix search ("pay" stems to "pai" and stops matching "payout").

---

## 7. Technology: SQLite, Express, React + TanStack Query

- **SQLite (WAL, `BEGIN IMMEDIATE`, busy timeout)** makes the project runnable with `npm start` and no services, which matters for a one-day exercise that reviewers must run. It gives real transactions, real concurrency semantics across processes (the 8-process race test runs against a real file), FTS5, and partial indexes. Its limit is a single writer on one machine; at the brief's scale, write transactions take well under a millisecond. Everything else (conditional updates, outbox, keyset queries) is standard SQL chosen so a move to Postgres is mechanical.
- **Express 5** with **zod** validation at the edge and plain service functions underneath: the HTTP layer is thin, so tests can exercise the API exactly as a browser would.
- **React + TanStack Query**: server state lives in one cache keyed by query; mutations update it optimistically and are always reconciled with the server's answer (rollback on conflict). No global client store was needed — the server is the source of truth.
- No ORM: the important logic *is* the SQL (conditional updates, keyset conditions), and hiding it would make it harder to review.

---

## What I deliberately did not build

User/team administration screens, attachments, @mentions, watchers, email/Slack delivery, SLA escalation jobs, item moves between teams, saved custom views, and rate limiting. Each is straightforward on top of the current model; none would change the hard parts.

## What I'd do with another week

1. **Postgres.** Same schema and queries; `SELECT … FOR UPDATE SKIP LOCKED` for the job queue, `LISTEN/NOTIFY` for live events, `tsvector` for search, monthly partitions for `activity`.
2. **Team administration** with its own audit trail, and moving items between teams (re-checking assignee eligibility and approval rules).
3. **Escalation**: a scheduled job that notifies leads when P1/P2 items are unowned for N minutes or approaching their due time — reusing the outbox.
4. **Description diffs** in history, and **@mentions** that add people to notifications.
5. **Browser-level tests** for the conflict UI checked into the repo (they were run ad hoc during development), and load tests against the write path.
6. **Operational visibility**: a page for dead-letter jobs with retry, structured logs and request IDs.

## If the application grew significantly

- Move to Postgres with read replicas for list/search traffic; the write path stays on the primary.
- Precompute dashboard counts (incrementally, from the activity stream) instead of counting on each request.
- Move search to a dedicated index if relevance ranking or cross-field filters outgrow FTS.
- Partition `activity` and `notifications` by time; archive closed items after a retention period.
- Replace polling (live hub, worker) with push (`LISTEN/NOTIFY` or a message broker), keeping the same event contracts.

## Assumptions

- Several hundred to a few thousand employees, organised into teams; a person can have different responsibilities in different teams.
- Anyone in a team should see all of that team's work; nobody outside it should know it exists.
- "Responsibility" means one owner at a time. Collaborators participate through comments.
- Payment and compliance work needs a second pair of eyes by default; everything else doesn't unless a lead says so.
- Closing is final until a lead reopens, with a recorded reason.
- Notifications in the app are enough for a first version.
