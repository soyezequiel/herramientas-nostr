---
name: integrate-nostr-bal-sdk
description: Integrate, migrate, debug, optimize, or review the nostr-bal-browser-sdk (Bunker Auto Login/BAL) in browser games and web applications. Use when adding Luna Negra launcher login, NIP-46 signing through SharedWorker, account switching, session restoration, clean launcher URLs, fast room-link startup, signer status UI, secure Nostr challenge authentication, logout, Vite bundling, permissions, CSP/COOP headers, or tests for a BAL integration.
---

# Integrate Nostr BAL SDK

Integrate `nostr-bal-browser-sdk` without exposing private keys, trusting a browser-supplied pubkey, or binding a saved game session to the wrong launcher identity.

## Establish context

1. Locate the target web package, server package, package manager, bundler, existing Nostr signer abstraction, session format, and launcher/game manifest.
2. Locate the SDK source of truth. When this skill is inside the SDK repository, walk upward to the `package.json` whose name is `nostr-bal-browser-sdk`; otherwise inspect the installed package and its README.
3. Read [references/integration-contract.md](references/integration-contract.md) completely before editing.
4. Read [references/troubleshooting.md](references/troubleshooting.md) when diagnosing an existing integration or when the target uses cross-origin isolation, CSP, SSR, a monorepo, or persistent session tokens.
5. Preserve unrelated authentication methods and the current account until a replacement BAL pubkey is known. BAL should run before normal login only when launcher/shared-session context exists; `?lnBal=off` must permit normal fallback.

Do not copy SDK internals into the game. Use its public exports and keep the game-specific adapter small.

## Implement

1. Determine the exact `gameId` and permission list from the launcher manifest. The `gameId` must equal the registered slug and permissions must match exactly. Include `get_public_key` and every operation the app actually invokes, including its login event kind.
2. Install the SDK and compatible peers in the browser package:
   - Use `file:../../herramientas nostr` only while developing both repositories locally.
   - Use `github:soyezequiel/herramientas-nostr` or a published version for reproducible builds.
   - Keep `nostr-game-protocol >=0.6.0 <1` and `nostr-tools >=2.23.9 <3` resolvable as single shared implementations.
3. Copy [assets/vite/bal-worker.ts](assets/vite/bal-worker.ts) and [assets/vite/bal-login.ts.template](assets/vite/bal-login.ts.template) for a Vite app. Replace every `__...__` placeholder and adapt the returned signer to the app's existing signer interface.
4. Give each game unique `launcherOriginStorageKey`, `activeHintKey`, and SharedWorker name. Never reuse another game's values.
5. Snapshot URL parameters before changing history. Call `hasLauncherContext()` first so the SDK validates and captures `lnOrigin`; then remove only `lnOrigin` with `history.replaceState`, preserving room/invite/debug parameters and the hash.
6. Reuse the SharedWorker session. Do not force the window fallback merely because a fresh URL contains `lnOrigin`; doing so repeats consent/handshake work and breaks fast room-link entry. The launcher must revoke the shared BAL session when its account changes.
7. Obtain and normalize the BAL pubkey once. Compare it with the current verified session subject before mutating state: keep the session and room for the same pubkey; for a different pubkey, clear the old signer/token/account caches before applying the new identity. If BAL fails or is rejected, do not erase the existing account, but do not enter an identity-restricted target as that account unless it is independently authorized.
8. Authenticate the signer against the game server with a fresh, one-use signed challenge. Never accept `getPublicKey()` alone as server authentication. Bind every restored game token to the current BAL pubkey before sending that token to the server.
9. Keep the critical path minimal. Await only signer connection, identity-bound server authentication, invite authorization, and the actual room join. Load Nostr profiles, avatars, contacts, presence, leaderboards, and other decoration in the background. Start independent BAL and directed-invite verification concurrently; join only after both required results are valid.
10. Keep the BAL signer ephemeral. Never persist a bunker URI, `nsec`, NIP-46 secret, or signer object. Do not restore a persisted display identity as authenticated when its BAL signer/token is gone. Persist only the launcher origin in the SDK per-tab mechanism and, if applicable, an identity-bound server token.
11. Register callbacks that clear the active signer and application session when the launcher revokes or ends BAL. On explicit account logout call `logout({ forgetLauncher: true })`. On page teardown release only the current tab with `logout()`; do not destroy a shared session still used by other tabs.
12. Configure the bundler and deployment: emit the worker from the same origin, dedupe the peer packages, allow `worker-src 'self'` in CSP, and preserve `window.opener`. If cross-origin isolation is required, prefer `COOP: restrict-properties` with the required COEP policy.

## Validate

Run the bundled auditor from the skill directory:

```text
node scripts/audit-bal-integration.mjs <target-project-root>
```

Treat failures as incomplete integration. Resolve warnings or document why the target architecture satisfies the requirement differently. The auditor is intentionally static; manually verify launcher manifest parity and server-side challenge consumption.

Read [references/test-matrix.md](references/test-matrix.md), then run the target's typecheck, unit tests, production build, and focused browser tests. Exercise rejection, same/different-account launches, shared tabs, revocation, explicit opt-out, wrong-account token restoration, URL cleanup with room parameters, room-link latency, and the no-`SharedWorker` fallback.

## Completion criteria

Finish only when:

- the app builds with one compatible copy of each peer dependency;
- the worker is emitted and served from the game origin;
- first login proves key control with a server challenge;
- restored tokens cannot cross BAL identities;
- rejection, revocation, explicit logout, and normal-login fallback behave deliberately;
- same-account BAL launch preserves the current session and room, while a verified different pubkey clears account-scoped state;
- `lnOrigin` can be removed after capture without dropping other URL arguments;
- profile/presence/social enrichment does not block authentication or room entry;
- no BAL credential is written to URL, logs, storage, analytics, or server responses;
- automated checks cover the critical lifecycle and the manual launcher test plan is reported.
