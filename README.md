# Pocketful

A payments service built stage by stage for the dark-factory hackathon: sending
money by handle, requesting and splitting bills, authorizing and capturing funds,
historical statements and corrections, and refunds with batch corrections.

See `FACTORY.md` for how this was built: the seats, their mandates, cost, and how
failures along the way were handled.

## Stages

Each stage folder is a complete, standalone, buildable service — not a diff
against the one before it.

| Stage | Adds |
|---|---|
| `stage-1/` | Core payments: send/request/split, an activity feed, atomic settlements |
| `stage-2/` | A browser UI for the above, plus authorizations and captures (holds) |
| `stage-3/` | Historical statements, `as_of`/`known_at` temporal queries, payment corrections |
| `stage-4/` | Refunds and operator batch corrections |

## Running a stage

Each stage folder has its own `RUN.md` with the exact build/run command. In
general:

```sh
docker build -t pocketful-stageN ./stage-N
docker run --rm -p 8080:8080 -e PORT=8080 pocketful-stageN
```

Then seed it and use it:

```sh
curl -X POST http://127.0.0.1:8080/_test/reset -H "Content-Type: application/json" -d '{...fixture...}'
```

The browser UI (from stage 2 onward) is reachable at `http://localhost:8080/`
once a fixture has been seeded.

## Verification

Every stage passed the harness's shipped checks and was independently reviewed
by a seat that rebuilt the image from scratch and re-ran it against a fresh
container, in addition to writing its own probes beyond the shipped suite. See
`room.json` (or the `rooms/` folder — see note below) for the full collaboration
record, and `FACTORY.md` for what each review found.

**A note on the room record:** the submitted run's room hit Band's message-volume
cap twice during the collaboration, which required continuing in a fresh room
each time (with the same three seats, recapped on the last known state). The
collaboration is therefore recorded across three room exports rather than one
continuous file.
