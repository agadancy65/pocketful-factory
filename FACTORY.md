# Factory

## Overview

Three Codex seats — Planner, Implementer, Reviewer — built Pocketful stage by stage,
with the Implementer never grading its own work: every stage was independently
rebuilt, re-run and re-probed by the Reviewer before being accepted.

## Seats

| Seat | Harness | Model | Role |
|---|---|---|---|
| Planner | Codex | deepseek-v4-flash | Breaks each stage into a handoff, delegates to the implementer, and only reports a stage done once the reviewer has accepted it. |
| Implementer | Codex | deepseek-v4-flash | Builds each stage from the written spec, runs the shipped tests itself, and reports what it built and how it checked it. |
| Reviewer | Codex | deepseek-v4-flash | Independently rebuilds the image, reruns the shipped suite against both the in-process code and the running container, and writes additional probes of its own beyond the shipped tests before accepting or rejecting. |

All three seats run on the same harness and model by design: Agent Router rations
its Claude/GPT-family models to a handful of released batches per day, which is
incompatible with a dark-factory run that cannot pause for a human to wait out a
quota window. deepseek-v4-flash is unrationed on the same account and was
consistently 6-10x faster to first response in local testing, so every seat was
pointed at it rather than splitting seats across models for variety's own sake.

## Design choices

- **Mandates stay generic.** No endpoint names, field names, error codes or track
  details appear in any mandate file; each describes only how its seat behaves
  (plan/delegate, build/self-test, verify independently), so the same three files
  could run either track unchanged.
- **Reviewer never trusts the shipped suite alone.** Every accepted revision was
  independently rebuilt from a clean image, rerun against both the in-process code
  and a freshly started container, and checked against hand-written probes that go
  beyond what ships (concurrency races, idempotency edge cases, historical-ledger
  invariants, cross-stage export/import). This caught one real conformance gap in
  stage 1 (see Failure handling) that the shipped tests did not surface.
- **One real repository for all five stages.** stage-1/ through stage-4/ are
  complete, standalone, buildable services, each copied forward from the last and
  extended, per the kickoff repo's own requirement that a stage folder not be a
  diff against its predecessor.

## Cost

Approximate Agent Router spend by stage (deepseek-v4-flash throughout):

| Stage | Approx. cost |
|---|---|
| Setup, toy rehearsal, misc. testing | ~$35 |
| Stage 1 | ~$80 |
| Stage 2 | ~$77 |
| Stage 3 | ~$58 |
| Stage 4 | ~$55 |

Cost did not track spec complexity in a simple way. Stage 2 (the browser UI) cost
nearly as much as stage 1 despite passing review cleanly on the first attempt,
most likely reflecting the UI's larger surface area and the reviewer's six-screen
check. Stage 1's cost reflects one real reviewer-found defect and a fix/re-review
cycle (see Failure handling) on top of a smaller service. Stages 3 and 4, despite
being conceptually denser (temporal queries, historical corrections, batch
operations), cost less than either — both passed review cleanly on the first
attempt, which suggests review cycles matter more to total cost than either raw
code size or spec complexity.

## Failure handling

- **One genuine conformance defect, caught by the reviewer, not the shipped
  suite.** In stage 1, `POST /splits` returned `422 validation_failed` for a
  wrongly-typed `participant_handles` field; per the spec's own error-precedence
  rules this should have been `400 malformed_request`. The shipped test file did
  not cover this case. The reviewer found it by testing against the spec's stated
  rules rather than only the shipped tests, reported it with a precise repro,
  Planner ruled the finding valid, Implementer fixed and committed it, and the
  reviewer independently re-verified the fix before accepting.
- **Two room-capacity stops, recovered without losing work.** The room hit Band's
  message-volume limit twice during the run (once during stage 2's build). Each
  time, a fresh room was opened with the same three seats, and the first message
  to the new room recapped the exact last-known commit and asked the seats to
  confirm its state (complete and reviewed, or still in progress) before
  continuing. No work was lost in either case — in the second instance, stage 2's
  implementation had already been committed before the room stopped; only the
  reviewer's sign-off was outstanding, and it was obtained cleanly in the new room.
- **One environment outage, not a band failure.** Docker Desktop was briefly
  closed mid-run, which would have failed any build/run step attempted during
  that window. It was restarted and the seats were told to retry; this was a
  local infrastructure gap, not a defect in the seats' behavior or judgment.
- **Reviewer corrected its own math once.** During stage 3's review, an initial
  probe reported two failures that the reviewer traced to its own reused test
  token rather than a service defect; it re-ran with a fresh token and reported
  the corrected result rather than letting the false failure stand.

## Rebuilding this factory

1. Create three Codex seats in Band Desktop, each pointed at an OpenAI-compatible
   endpoint serving an unrationed model (here: Agent Router + deepseek-v4-flash),
   with "Never ask" approval and full tool access.
2. Point each seat's Role file at its matching file in `mandates/` (named after
   the seat).
3. Set each seat's working directory to the result repository.
4. Add all three to one room and dispatch one stage's full spec text at a time to
   the planner seat, tagging only that seat. Send nothing further until the
   planner reports the stage accepted.
5. If a room's message volume is capped, open a fresh room with the same three
   seats and recap the last known commit before continuing.
