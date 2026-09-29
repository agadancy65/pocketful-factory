# Pocketful stage 2 - build and run

The service is a single containerised Node.js HTTP service. It uses only the Node
standard library, so the image needs no install step, no external service and no
outbound network access at run time.

## Build

From the repository root (`C:\Users\HomePC\band-work\result`):

```
docker build -t pocketful-stage-2 ./stage-2
```

## Run

```
docker run --rm -p 8080:8080 -e PORT=8080 pocketful-stage-2
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
       "payments":[],"requests":[],
       "authorizations":[{"id":"a_1","from_user_id":"u_ada","to_user_id":"u_bob",
                          "amount":2000,"note":"deposit","visibility":"public",
                          "status":"open","expires_at":"2026-09-24T20:00:00+01:00"}]}'
# 204

curl -s -X POST http://127.0.0.1:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'
# {"user_id":"u_ada","display_name":"Ada","token":"..."}

curl -s http://127.0.0.1:8080/me -H 'Authorization: Bearer <token>'
# {"user_id":"u_ada",...,"balance":10000,"total":10000,"available":8000,"held":2000,...}
```

## Acceptance checks

`stage-2/tests/checks.js` runs the stage 1 acceptance checks plus the stage 2
checks (holds and the derived wallet numbers, authorizations, captures, voids,
expiry, the browser screens and the upgrade from a stage 1 export). It needs
Node.js on the machine that runs it, not in the image.

Against a running container:

```
node ./stage-2/tests/checks.js http://127.0.0.1:8080
```

In-process, without Docker (starts the service on `PORT`, default 8099):

```
node ./stage-2/tests/checks.js
```

Both forms exit `0` when every check passes and print a failure list otherwise.