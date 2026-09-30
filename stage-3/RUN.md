# Pocketful stage 3 - build and run

The service is a single containerised Node.js HTTP service. It uses only the Node
standard library, so the image needs no install step, no external service and no
outbound network access at run time.

## Build

From the repository root (`C:\Users\HomePC\band-work\result`):

```
docker build -t pocketful-stage-3 ./stage-3
```

## Run

```
docker run --rm -p 8080:8080 -e PORT=8080 pocketful-stage-3
```

`PORT` selects the listening port (default `8080`) and the service always binds
`0.0.0.0`. Nothing else needs to be configured, mounted or seeded: the process is
ready as soon as it starts listening, so `GET /health` answers within a second of
container start.

To use another host port, change the mapping and `PORT` together, e.g.
`-p 9000:9000 -e PORT=9000`.

## Screens

The browser screens and the API share the same URLs. A request with
`Accept: text/html` gets the screen; any other client gets JSON.

| Route | Screen |
|---|---|
| `/` | Balance, pay form, request form, authorise form and the activity feed |
| `/requests` | Incoming and outgoing requests, with pay, decline and cancel |
| `/split` | Split form with a live preview of the shares |
| `/authorizations` | Holds: authorise, capture and release |
| `/signup`, `/login` | Signup and login |

`POST /auth/login` and `POST /auth/signup` set an http-only `pocketful_token`
cookie so a browser stays signed in across the screens.

## Stage 3 API

Every payment now carries `created_at`, an RFC 3339 instant with an offset.

### Historical reads

`GET /me` and `GET /statement` accept two optional instant parameters:

- `as_of` - read the wallet as it stood at that instant. A payment made exactly
  at `as_of` counts as having happened. On `/me` all four money fields describe
  the same view.
- `known_at` - use, for every payment, the latest revision recorded at or before
  that instant. A payment with no revision recorded yet contributes nothing.

Both are RFC 3339 instants with an offset; anything else, including an empty
value, is `422 validation_failed`. Both are echoed back exactly as given.

```
GET /me?as_of=2026-09-24T13%3A20%3A00%2B00%3A00&known_at=2026-09-24T14%3A00%3A00%2B00%3A00
```

### Statements

```
GET /statement?from=<instant>&to=<instant>&limit=50&offset=0
```

Returns the payments the caller sent or received in the half-open window
`[from, to)`, oldest first by the selected effective time and then by payment
id. Each entry carries the payment, `delta`, `balance_after`, `revision`,
`effective_at` and `recorded_at`. `opening_balance` is the balance immediately
before `from` and `closing_balance` the balance immediately before `to`; the
opening plus every delta in the window equals the closing, whatever `limit` and
`offset` are used. The activity-feed visibility rules do not apply here.

The first response of a read also returns an opaque `snapshot` token that
freezes that window, revisions, entries and balances:

```
GET /statement?snapshot=<token>&limit=...&offset=...
```

Paging a snapshot is stable across later payments and corrections. Only `limit`
and `offset` may accompany a snapshot; `from`, `to` or `known_at` with a
snapshot is `422 validation_failed`, and an unknown, foreign or pre-reset token
is `404 not_found`. Tokens live until the next `_test/reset`.

### Corrections and revisions

```
GET  /payments/{payment_id}/revisions
POST /payments/{payment_id}/corrections
```

Only the two parties may read the revision history; a third party gets `404`
even for a public payment, and no token is `401`. Revision 1 is the original
payment (`effective_at = recorded_at = created_at`, `reason: ""`).

A correction requires an idempotency key and the original sender:

```
{"expected_revision":1,"amount":400,"effective_at":"2026-09-20T12:00:00+00:00","reason":"corrected amount"}
```

All fields are required; `amount` is `0..1000000000`, `reason` is 1..200
characters and `effective_at` is not later than now. The difference from the
previous amount moves between the same two wallets in one atomic step. An
unknown payment is `404`, a non-sender `403 forbidden`, a stale revision
`409 stale_revision`, an unaffordable debit `409 insufficient_funds`, a
correction that would overdraw a wallet at any past effective or hold boundary
`409 historical_overdraft`, and a settlement member or capture
`422 linked_payment_immutable`. A successful replay returns the original
revision with `200`, even after newer revisions.

### Holds in historical views

An authorisation holds money from creation; a non-final capture reduces the hold
at capture time, and a final capture, a void or the expiry deadline releases
whatever remains. Authorisations expose `closed_at` (`null` while open).
`GET /statement` still contains money movements only - authorisations, releases
and expiry are not payments, while captures appear exactly once with their
`authorization_id`.

## Smoke test

```
curl -s http://127.0.0.1:8080/health
# {"status":"ok"}

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"currency":"EUR","minor_units":2,"authorization_ttl_seconds":600,
       "users":[{"id":"u_ada","email":"ada@example.com","password":"correct horse",
                 "display_name":"Ada","handle":"ada","balance":10000},
                {"id":"u_bob","email":"bob@example.com","password":"correct horse",
                 "display_name":"Bob","handle":"bob","balance":2500}],
       "payments":[{"id":"p_1","from_user_id":"u_ada","to_user_id":"u_bob",
                    "amount":500,"note":"coffee","created_at":"2026-09-01T10:00:00+01:00"}],
       "requests":[]}'
# 204

curl -s -X POST http://127.0.0.1:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'
# {"user_id":"u_ada","display_name":"Ada","token":"..."}

curl -s http://127.0.0.1:8080/me -H 'Authorization: Bearer <token>'
# {"user_id":"u_ada",...,"balance":10000,"total":10000,"available":10000,"held":0,...}

curl -s 'http://127.0.0.1:8080/me?as_of=2026-09-01T09%3A00%3A00%2B01%3A00' -H 'Authorization: Bearer <token>'
# {"user_id":"u_ada",...,"balance":10500,...,"as_of":"2026-09-01T09:00:00+01:00"}

curl -s http://127.0.0.1:8080/statement -H 'Authorization: Bearer <token>'
# {"opening_balance":10500,"entries":[{"payment":{...},"delta":-500,"balance_after":10000,
#  "revision":1,...}],"closing_balance":10000,"has_more":false,"snapshot":"..."}

curl -s -X POST http://127.0.0.1:8080/payments/p_1/corrections \
  -H 'Authorization: Bearer <token>' -H 'Idempotency-Key: fix-1' \
  -H 'Content-Type: application/json' \
  -d '{"expected_revision":1,"amount":400,"effective_at":"2026-09-01T10:00:00+01:00","reason":"corrected amount"}'
# {"payment_id":"p_1","revision":2,"amount":400,...}
```

## Acceptance checks

`stage-3/tests/checks.js` runs the stage 1 and stage 2 acceptance checks plus the
stage 3 checks (payment timestamps, `as_of` and `known_at`, statements, stable
snapshot pagination, revisions and corrections, historical holds, linked
payments, and the stage 1, stage 2 and stage 3 exports). It needs Node.js on the
machine that runs it, not in the image.

Against a running container:

```
node ./stage-3/tests/checks.js http://127.0.0.1:8080
```

In-process, without Docker (starts the service on `PORT`, default 8099):

```
node ./stage-3/tests/checks.js
```

Both forms exit `0` when every check passes and print a failure list otherwise.