# Design — a reviewer should never reach a dead end

**Status:** design proposed, not built. Fix 1 is independently shippable and is the one that matters.
**Date:** 2026-08-17

---

## The problem

A reviewer navigated to a build URL without a session and received this, rendered as the whole page:

```json
{"error":"Authentication required."}
```

Reproduced against production on 2026-08-17:

```
GET /api/me                              401   {"error":"Authentication required."}
GET /builds/<id>/index.html              401   {"error":"Authentication required."}
    Accept: text/html
    Sec-Fetch-Mode: navigate
```

The second line is the defect. A **browser navigation** — someone clicking a link, restoring a tab,
or opening a bookmark — is answered with a JSON body and no way forward. There is no link, no
explanation, and nothing to click.

**The landing page it should have reached already exists and is already correct.** `/review/` boots,
calls `/api/me`, catches the 401, and renders a gate (`packages/server/shell/shell.js`, `boot()`):

> **Greenroom** — This page needs a review link. Ask your contact for a fresh one.

`/review/` returns **200 with no session**, so it is safe to send an unauthenticated visitor there and
there is no redirect loop. Nothing routes to it.

## How a reviewer arrives with no session

Four ways, all real. The first is the one observed.

1. **A different browser or profile.** Sessions are a cookie on one browser. The reviewer redeemed on
   their laptop in Chrome and opened the link later in another browser; nothing in the product signals
   that this is what happened.
2. **The 30-day cookie expires.** `maxAge: 60 * 60 * 24 * 30` in `/review/:token`
   (`packages/server/src/routes.ts`). On day 31 every URL they hold becomes the JSON above.
3. **A bookmark or a pasted deep link.** Redemption lands the reviewer on
   `/builds/<id>/index.html`, and the build id is then in the address bar. Whatever they save or
   forward is build-specific and carries no credential.
4. **Someone forwards a URL rather than a link.** The recipient has no session at all.

## Where the behaviour lives

| | |
| :---- | :---- |
| `packages/server/src/auth.ts` | `requirePrincipal()` throws `HttpError(401, 'Authentication required.')` |
| `packages/server/src/app.ts` | `app.onError` renders that as JSON, for every caller |
| `packages/server/src/routes.ts` | `/builds/:id/*` is guarded by `requirePrincipal()` |
| `packages/server/src/routes.ts` | `/review/:token` redeems, sets `gr_session`, redirects to the latest build |
| `packages/server/shell/shell.js` | `boot()` renders the gate when `/api/me` fails |

The 401 is correct. Rendering it as JSON to a navigation is not.

---

## Fix 1 — a navigation gets the gate, not JSON

**On a 401, if the request is a navigation, redirect to `/review/`.** Detect it with
`Sec-Fetch-Mode: navigate`, falling back to `Accept: text/html`. Everything else — API calls, the
addon's fetches, `curl` — keeps the JSON 401 byte for byte.

Roughly ten lines in the error path, plus tests. **No new credential surface and no new concepts:** it
routes an existing failure to an existing page that already says the right thing.

This alone removes every dead end in the product. It should ship on its own, before anything below.

**The redirect must be `no-store`.** The same requirement Fix 2 carries, and it applies here first
because this is the fix that ships alone. These 401s come from `/builds/*`, which sets
`private, max-age=31536000, immutable` (`packages/server/src/app.ts`) — so a 302 emitted from that
neighbourhood is exactly the response you do not want an intermediary holding for a year. A reviewer
whose session later becomes valid would keep being bounced to the gate by a cached redirect.

**Detection has to fail towards JSON, not towards the redirect.** `Sec-Fetch-Mode: navigate` is on
every current browser but absent from older ones and from `curl`; `Accept: text/html` is the stated
fallback. The panel's own `fetch` calls must never match: if one did, a failed API call would answer
302-to-a-login-page and the addon would report something baffling instead of the error it got.

**Tests:** a navigation to a guarded path with no session redirects to `/review/`, and that redirect
carries `no-store`; an XHR to the same path still receives JSON 401 — asserted adversarially, with
the `Accept` headers the addon actually sends, not a happy-path stub; an authenticated navigation is
untouched.

---

## Fix 2 — a deep link that carries its own key

`/review/<token>?to=/builds/<id>/index.html?path=/story/x`

One route redeems tokens — the one that already does — and the destination rides as a parameter.

The alternative, accepting `?k=<token>` on any path, was considered and rejected: it spreads a bearer
credential across every route in the product and makes *"where can a credential be spent"*
unanswerable.

🔴 **The hazard is open redirect, and it is the whole risk of this fix.** `to` must be validated as a
same-origin path:

- must begin `/builds/` or `/review/`
- must not begin `//` (protocol-relative)
- must not contain a scheme
- reject rather than sanitise on anything else

**Also:** the redirect must be `no-store`. `/builds/*` sets `private, max-age=31536000, immutable`
(`packages/server/src/app.ts`), and a cached 302 would pin someone to a stale build.

**Note how little of this is needed in practice.** `/review/:token` already lands on the *latest*
build, so the only real reason to deep link is pointing at a **specific story** — which
`?path=/story/…` on the build root already handles. `to` covers exactly that case.

---

## Fix 3 — land them where they were going

When Fix 1 redirects, carry the original path so that redeeming a link drops the reviewer on the page
they were trying to reach rather than the latest build's front door.

Smallest of the three in concept, but it touches the shell as well as the server, so it goes last.

---

## Deliberately not doing: a stable `/current/` alias

An alias that always resolved to the newest build would end bookmark rot in one move. It is rejected
because it undoes a decision made on purpose.

**Reviewers pin to a build so that comments attach to a known version**, and the staleness bar is the
mitigation — added 2026-08-16 after a reviewer three builds behind reported a bug that had been fixed
hours earlier. A `/current/` alias reintroduces exactly that failure, and quietly, because the URL
would look permanently correct.

Recorded here so it is not re-proposed as an obvious win.

---

## Sequencing and deployment

**Fix 1 first, alone.** It is small, it carries no security surface change, and it removes the failure
that prompted this note.

Fixes 2 and 3 are conveniences on top and want the redirect-guard tests written before they go
anywhere near production.

⚠ **Deploying the sidecar redeploys a live client review surface.** At the time of writing, a client
is mid-review and a layout batch presents the following morning. None of this is urgent enough to
redeploy into that.

And "deploy Fix 1" is not a small deploy. The running sidecar is many commits behind `main`, so the
next deploy ships everything since — the component review unit, the withdrawal of the build-arrival
demotion, re-confirmation and batch approval, the retirement of `needs_reconfirm` with its v7
migration, and the cache headers. Whenever it goes, it wants to be treated as a release with the
migration checked on a copy of the production store first, not as a ten-line hotfix that happens to
carry passengers.
