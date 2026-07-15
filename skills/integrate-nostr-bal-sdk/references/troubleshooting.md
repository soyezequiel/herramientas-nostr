# BAL troubleshooting

## Contents

- Launcher handshake
- Worker and multiple tabs
- Account switching and URL state
- Slow login and room links
- Permissions and signing
- Session identity
- Bundling and dependencies
- Tests and deployment

## Launcher handshake

### No launcher context is detected

Check that the launcher opened the game with an encoded, origin-only `lnOrigin`; the value must not contain a path. Confirm `window.opener` exists, launcher navigation did not use `noopener`, and COOP did not sever the opener. `http` and `https` are accepted; arbitrary schemes are rejected.

Directly opening a clean URL can reconnect only while a same-origin SharedWorker session has left a valid active hint. A stale launcher-origin value alone does not create credentials.

### Consent is visible but the game appears stuck

Wire the optional `onConsentRequired` callback and display a launcher-focused state. Offer `requestLauncherFocus()` from a user gesture. Confirm launcher and game use identical `gameId` and permission arrays.

### Rejection loops

`USER_REJECTED` and `PERMISSION_DENIED` opt the tab out of BAL, remove launcher context from the URL/session, and return `null`. Continue with normal login. Do not immediately call `connect` again.

## Worker and multiple tabs

### Worker is not emitted or returns 404

Use a local worker entry containing only `import "nostr-bal-browser-sdk/worker"`, reference it with `new URL("./bal-worker.ts", import.meta.url)`, and ensure the bundler sees a literal relative path. Confirm the production server serves hashed worker assets with the correct JavaScript MIME type and CSP permits `worker-src 'self'`.

### Second tab cannot reuse the session

Use the same worker name and `activeHintKey` within one game, but unique values across different games. Both tabs must share the exact origin (scheme, host, and port). Do not delete the active hint or call explicit-forget logout on ordinary page teardown.

### Closing the first tab kills signing

Ensure the app uses the SharedWorker path and only releases the current connection. A browser without SharedWorker uses the fallback and cannot promise cross-tab continuity after the opener tab disappears.

## Account switching and URL state

### Opening BAL logs out the same account

The app clears its identity before it knows the incoming signer pubkey. Snapshot the current verified subject, connect BAL, normalize `getPublicKey()`, and compare first. Preserve the room and session when pubkeys match. Clear account-scoped state only after a different valid pubkey is proven.

### A rejected or failed BAL attempt deletes the current account

Do not make logout the first step of an attempted replacement. Until a different signer is proven, keep the current session locally. If the pending action is a directed room/invite, block that action or show retry; preserving the old account does not authorize it for the new target.

### Launcher changed accounts but the old shared signer returns

The game cannot infer the launcher's new account from `lnOrigin`; it identifies an origin, not a user. The launcher must revoke/end the previous BAL session on account change. Do not disable SharedWorker reuse globally as a workaround: it makes normal same-account launches slow and loses multi-tab continuity. If the product requires explicit account selection, extend the launcher protocol with an authenticated account/session hint and update both sides.

### `lnOrigin` makes the URL look dirty

Call `hasLauncherContext()` before editing the URL so the SDK validates and stores the origin in `sessionStorage`. Then use `URL` plus `history.replaceState` to delete only `lnOrigin`. Preserve `join`, `lnInvite`, transport/debug flags, unrelated query parameters, and the hash. Never remove `lnOrigin` before the SDK captures it.

## Slow login and room links

### Login waits several seconds after BAL is already connected

Look for a blocking kind `0` profile query, avatar/contact lookup, presence publication, game-info request, or repeated `getPublicKey()` call. Activate/authenticate from the already resolved pubkey, then hydrate public profile data in the background. A first consent and a required server challenge remain critical; presentation metadata does not.

### A room link pays BAL and invite latency one after another

Snapshot the initial URL and start BAL connection plus directed-invite verification concurrently. Await both only at the protected join boundary. Do not await presence, contacts, profile, leaderboard, or launch-request polling first.

Prefer dependency assertions over fragile stopwatch tests: hold profile/presence promises unresolved and assert login or room joining still advances; hold BAL and invite verification separately and assert total orchestration is parallel rather than serial.

### First visitor to a room link is slower than later visitors

If the client tries `join`, waits for `404`, then calls `create`, the first visitor pays two round trips. Add an atomic/idempotent join-or-create server action when the protocol permits it. Preserve conflict handling for simultaneous first entrants.

## Permissions and signing

### Permission denied for one feature

Compare the launcher manifest to the game adapter character-for-character. Add only the required operation: for example, signing a login event requires `sign_event:22242`; posting a note requires `sign_event:1`; NIP-44 calls require both relevant encrypt/decrypt permissions. Updating only the game code is insufficient—the launcher registration must change too.

### A signing request hangs or expires

Observe status transitions and launcher UI. Check that the SharedWorker remains attached, the session expiry is valid, and the launcher can reach its bunker/relay. Do not implement an unbounded retry loop; the SDK retries the non-worker fallback once when an ephemeral signer dies.

## Session identity

### The wrong user appears after launcher login

The app restored its own token before comparing it with the BAL pubkey. Connect BAL first, obtain the pubkey, compare it with the verified/declared token subject, clear mismatches, then authenticate. Also scope profile caches and subscriptions by pubkey.

### Reload asks for a signature every time

Keep a server-issued game token with a stable server signing secret and restore it only after BAL identity binding. A server secret regenerated on every deploy invalidates all sessions. Do not solve this by persisting the BAL signer or bunker URI.

## Bundling and dependencies

### Types differ or `instanceof BalError` fails unexpectedly

The app likely contains multiple copies of `nostr-game-protocol` or `nostr-tools`. Keep them as direct compatible dependencies of the game, leave them as peers of the SDK, inspect the lockfile/npm dependency tree, and configure bundler deduplication.

### Development works but clean CI install fails

Do not commit a lockfile that points to an unavailable local `file:` path. Use the GitHub/published dependency for CI, make Git available in the build image, and verify the locked revision. Run the SDK `prepare` build when consuming it from Git.

### SSR crashes on `window`, `location`, or `SharedWorker`

Create and call BAL only in a browser-only module/lifecycle. Do not instantiate the coordinator during server rendering. The SDK intentionally targets browsers.

## Tests and deployment

### Vitest state leaks between tests

The SDK coordinator is a page singleton. Reset modules between tests, stub browser globals before importing the adapter, and inline `nostr-bal-browser-sdk` in Vitest dependency handling when mocking its peer imports.

### Cross-origin-isolated build loses the launcher

`COOP: same-origin` breaks the cross-origin opener relationship. Where the browser supports it, `COOP: restrict-properties` plus the needed COEP policy preserves limited opener communication and cross-origin isolation. Test the actual supported browser matrix; provide a non-isolated/fallback launch if necessary.
