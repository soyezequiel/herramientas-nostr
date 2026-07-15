# BAL integration contract

## Contents

- Package and runtime model
- Configuration contract
- Canonical client flow
- Fast startup, URL hygiene, and room links
- Account continuity and switching
- Server authentication
- Session-token binding
- Logout and lifecycle
- Bundler and deployment
- Security invariants

## Package and runtime model

`nostr-bal-browser-sdk` gives a browser app a NIP-46-compatible signer without exposing or persisting an `nsec` or bunker URI in the game.

Public entry points:

- `nostr-bal-browser-sdk`: `createBalBrowserLogin`, signer/status types, and lower-level exports.
- `nostr-bal-browser-sdk/worker`: SharedWorker entry; import it only from the game's worker entry module.

The primary path keeps one NIP-46 client in a same-origin SharedWorker and shares it across game tabs. If `SharedWorker` is unavailable or creation fails, the SDK falls back to a window-based `BalGameClient`. A launcher opens the game with an exact encoded origin:

```text
https://game.example/?lnOrigin=https%3A%2F%2Fluna.example
```

`?lnBal=off` is an explicit opt-out and overrides saved/shared context.

## Configuration contract

Create one coordinator per page:

```ts
const bal = createBalBrowserLogin({
  gameId: "registered-game-slug",
  gameName: "Human game name",
  permissions: [
    "get_public_key",
    "sign_event:22242",
  ],
  launcherOriginStorageKey: "registered-game-slug.bal.launcher-origin.v1",
  shared: {
    createWorker: () => new SharedWorker(
      new URL("./bal-worker.ts", import.meta.url),
      { type: "module", name: "registered-game-slug-bal-v1" },
    ),
    activeHintKey: "registered-game-slug.bal.shared-active.v1",
  },
});
```

The launcher registration is authoritative for `gameId` and `permissions`. Request only required capabilities. Permission strings are operation-specific, for example `sign_event:1`, `sign_event:22242`, `nip04_encrypt`, `nip04_decrypt`, `nip44_encrypt`, and `nip44_decrypt`.

Optional configuration defaults are Luna Negra-specific:

- `launcherName`: `Luna Negra`
- `launcherOriginParam`: `lnOrigin`
- `balModeParam`: `lnBal`
- `consentRequiredMessage`: `luna-negra:bal-consent-required`
- `focusRequestMessage`: `luna-negra:bal-focus-request`

Do not override them unless integrating another compatible launcher.

## Canonical client flow

Use the coordinator's object API (`getStatus`, `subscribeStatus`, `hasLauncherContext`, `connect`, `requestLauncherFocus`, and `logout`). Integrate it into the app's existing signer abstraction rather than making every feature BAL-aware.

Startup order:

1. Snapshot URL parameters and the current verified game identity/token without deleting either.
2. Call `hasLauncherContext()`. This validates/captures `lnOrigin` before any URL cleanup.
3. If BAL context exists, call `connect(onLauncherLogout, onConsentRequired)` and obtain the pubkey once.
4. Compare that normalized pubkey with the current verified session subject before clearing state.
5. Reuse a saved token only when its subject equals the BAL pubkey. The server must still verify token integrity and expiry.
6. If no matching token exists, request a fresh game-server challenge and sign it.
7. If BAL returns `null`, preserve the current account locally and expose retry/normal-login UX. Do not use it to enter a directed room or protected target that requires the unresolved launcher identity.

Illustrative orchestration:

```ts
const hadContext = bal.hasLauncherContext();
const previous = readVerifiedGameIdentity();
const signer = hadContext
  ? await bal.connect(onLauncherLogout, showLauncherApproval)
  : null;

if (signer) {
  const pubkey = normalizePubkey(await signer.getPublicKey()); // call once
  if (previous && previous.pubkey !== pubkey) clearAccountScopedState();
  if (token && tokenBelongsToPubkey(token, pubkey)) {
    await authenticateWithToken(token); // server verifies it
  } else {
    clearToken();
    await authenticateWithSignedChallenge(signer);
  }
} else {
  keepCurrentSessionOrShowNormalLogin();
}
```

`connect` can reuse an active shared session in a directly opened tab. The signer exposes `method: "nip46"`, `getPublicKey`, `signEvent`, NIP-04/NIP-44 encrypt/decrypt methods, and `close`.

The status phases are `idle`, `connecting`, `reconnecting`, `awaiting_approval`, `connected`, `signing`, `encrypting`, `decrypting`, `signed`, `disconnecting`, `disconnected`, `rejected`, and `error`.

## Fast startup, URL hygiene, and room links

Treat authentication and navigation as a dependency graph, not one long sequence.

Critical work for a directed room link:

- BAL signer/pubkey resolution;
- identity-bound server login when the game has authenticated sessions;
- invite signature/audience/room/recipient verification;
- the actual room connection/join.

Start independent BAL and invite verification together. Await both before entering the protected room, but do not wait for profile kind `0`, avatar, contacts, presence publication, launcher activity polling, leaderboard refresh, or other decoration. Cache or hydrate those after the authenticated identity is visible. Avoid calling remote `getPublicKey()` twice; pass the resolved pubkey into downstream login code.

For a public room link, resolve the identity required by that game's authorization model and join immediately. If the link can lazily create a missing room, prefer a server-side join-or-create action; a client-side `join` then `create` fallback costs two network round trips for the first entrant.

`lnOrigin` is routing/security context, not a credential, and does not need to remain visible after capture. Clean it only after `hasLauncherContext()` has stored the validated origin:

```ts
const initialParams = new URLSearchParams(location.search);
const explicitBalLaunch = initialParams.get("lnBal") !== "off"
  && Boolean(initialParams.get("lnOrigin")?.trim());
const hasBalContext = bal.hasLauncherContext();

if (explicitBalLaunch && hasBalContext) {
  const url = new URL(location.href);
  url.searchParams.delete("lnOrigin");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
```

Delete only the consumed key. A URL such as `?join=AB12&lnInvite=...&lnOrigin=...#game` must retain `join`, `lnInvite`, and `#game` until their own handlers consume them. Snapshot parameters before cleanup so concurrent startup tasks use a stable input.

## Account continuity and switching

Never implement account switching as “clear, then connect.” Connect and compare first:

- Same normalized pubkey: preserve the existing game session, room membership, and account caches; attach/refresh the BAL signer without a logout flash.
- Different normalized pubkey: leave or rebind the current room according to game rules, clear the old signer/token/subscriptions/caches, then authenticate/apply the new identity.
- Rejection or transient failure before a new pubkey is proven: retain the current account locally. Keep identity-restricted navigation pending or show retry rather than entering it as the old account.
- No current verified identity: apply the BAL identity normally after server authentication.

The SharedWorker is intentionally authoritative across tabs. Do not disable it or force `BalGameClient` simply because the URL contains a new `lnOrigin`; that turns every room link into a fresh handshake. The launcher must end/revoke the old shared BAL session when its own account changes. Without launcher revocation or an authenticated desired-account hint, the game cannot infer that a shared signer belongs to a launcher account that changed elsewhere.

Persisted profile/display identity is not an authentication session. If BAL credentials and an identity-bound server token are both absent, show it only as cached presentation data or discard it; never silently restore it as logged in.

## Server authentication

Do not authenticate a browser by accepting a pubkey. Prove key control:

1. Generate a cryptographically random challenge for the current connection/login attempt.
2. Return it to the client with a short expiration.
3. Ask the signer to sign an event such as kind `22242` containing the exact challenge tag.
4. On the server verify the event kind, exact challenge, timestamp freshness, signature, and one-use status.
5. Derive the authenticated pubkey from the verified event, consume the challenge, and issue the game session.

Example unsigned event:

```ts
{
  kind: 22242,
  created_at: Math.floor(Date.now() / 1000),
  tags: [["challenge", challenge]],
  content: "",
}
```

Use the server stack's cryptographically secure RNG and Nostr signature verifier. Bind challenges to the requesting connection or login transaction. Reject replays, mismatches, stale timestamps, unexpected kinds, and invalid signatures.

## Session-token binding

A named browser tab can retain a token for account A and later be opened by the launcher for account B. Therefore:

- Record whether the token originated from BAL or standalone login.
- Make the token subject/pubkey inspectable or expose a safe server endpoint that reports the verified subject.
- Compare the current BAL pubkey to that subject before reuse.
- Treat client-side token decoding only as routing logic, never as token verification.
- Clear mismatched, malformed, legacy-ambiguous, or BAL-dependent tokens when no BAL signer can be restored.
- Verify signature, expiry, audience, and revocation server-side on every token login.

## Logout and lifecycle

`logout()` releases only the current tab. If other game tabs remain attached, the SharedWorker keeps the remote signer alive. When the final tab releases, the worker closes its local client and sends NIP-46 logout.

Use `logout({ forgetLauncher: true })` for explicit account logout. Also clear the app signer, identity, session token, cached account-scoped data, and active subscriptions. The `onLauncherLogout` callback must perform the same application-level invalidation after launcher revocation.

Do not call the explicit-forget variant merely because a page is navigating or entering the back/forward cache.

## Bundler and deployment

- The worker entry must contain `import "nostr-bal-browser-sdk/worker"` and be referenced through `new URL(..., import.meta.url)` so Vite emits it.
- Serve the emitted worker from the game origin. SharedWorker does not bridge origins.
- Dedupe `nostr-game-protocol` and `nostr-tools` in Vite/monorepo resolution.
- Build for a modern browser target compatible with module workers (the reference app uses `es2022`).
- With CSP, include `worker-src 'self'` and do not widen `connect-src` beyond the relays/services the app needs.
- Preserve `window.opener` and exact-origin `postMessage`. Avoid `rel=noopener` on launcher navigation.
- `Cross-Origin-Opener-Policy: same-origin` severs a cross-origin launcher opener. If the game needs COOP/COEP isolation, use `restrict-properties` where supported and verify the target browsers.
- Git dependencies require Git during clean install/build. Commit the lockfile and verify CI resolves the intended SDK revision.

## Security invariants

- Never store or log `bunkerUri`, `nsec`, NIP-46 client secrets, raw authorization messages, or signer objects.
- Never put credentials in query parameters. Only the validated launcher origin belongs in `lnOrigin`.
- Never use `"*"` as `postMessage` target origin; require exact event origin and source.
- Never trust display names, profile metadata, URL pubkeys, or decoded token bodies as authentication.
- Never silently reuse a game session across different BAL pubkeys.
- Never request permissions absent from the launcher manifest or broader than the game needs.
