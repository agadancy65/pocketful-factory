# Pocketful stage 1 - build and run

The service is a single containerised Node.js HTTP service. It uses only the Node
standard library, so the image needs no install step, no external service and no
outbound network access at run time.

## Build

From the repository root (`C:\Users\HomePC\band-work\result`):

```
docker build -t pocketful-stage-1 ./stage-1
```

## Run

```
docker run --rm -p 8080:8080 -e PORT=8080 pocketful-stage-1
```

`PORT` selects the listening port (default `8080`) and the service always binds
`0.0.0.0`. Nothing else needs to be configured, mounted or seeded: the process is
ready as soon as it starts listening, so `GET /health` answers within a second of
container start.

To use another host port, change the mapping and `PORT` together, e.g.
`-p 9000:9000 -e PORT=9000`.

## Smoke test

```
curl -s http://127.0.0.1:8080/health
# {"status":"ok"}

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/_test/reset \
  -H 'Content-Type: application/json' \
  -d '{"currency":"EUR","minor_units":2,
       "users":[{"id":"u_ada","email":"ada@example.com","password":"correct horse",
                 "display_name":"Ada","handle":"ada","balance":10000},
                {"id":"u_bob","email":"bob@example.com","password":"correct horse",
                 "display_name":"Bob","handle":"bob","balance":2500}],
       "payments":[],"requests":[]}'
# 204

curl -s -X POST http://127.0.0.1:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'
# {"user_id":"u_ada","display_name":"Ada","token":"..."}
```

## Acceptance checks

`stage-1/tests/checks.js` runs the stage 1 acceptance checks (reset and login,
payments, requests, splits, feed visibility, concurrency invariants, export/import
and settlements). It needs Node.js on the machine that runs it, not in the image.

Against a running container:

```
node ./stage-1/tests/checks.js http://127.0.0.1:8080
```

In-process, without Docker (starts the service on `PORT`, default 8099):

```
node ./stage-1/tests/checks.js
```

Both forms exit `0` when every check passes and print a failure list otherwise.