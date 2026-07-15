# BAL test matrix

Run automated unit/integration coverage where possible and complete the browser/launcher cases applicable to the target.

| Case | Expected result |
|---|---|
| Launcher opens first tab with valid `lnOrigin` | Exact-origin handshake completes; signer pubkey is server-authenticated |
| Valid `lnOrigin` plus `join`, `lnInvite`, other query keys, and hash | SDK captures origin; URL cleanup removes only `lnOrigin`; remaining routing state is preserved until consumed |
| Launcher requires consent | App enters `awaiting_approval`; focus action returns attention to launcher |
| User rejects consent while another account is active | BAL returns `null`; existing account remains locally active; identity-restricted pending navigation does not proceed as that account |
| `?lnBal=off` with saved context | BAL is not attempted; status returns to idle |
| Clean second same-origin tab | It reuses the active SharedWorker session without a second NIP-46 client |
| Same account opens an explicit BAL/room link | Existing game session and room remain; shared BAL is reused; no logout flash or repeated profile wait |
| Different BAL pubkey is proven | Old signer/token/subscriptions/caches are cleared before the new identity is applied |
| Launcher changes account | Launcher revokes the old shared BAL session before granting the new signer |
| Original launched tab closes | Remaining shared tab can still sign |
| Last attached tab closes | Worker releases its client and launcher signer session |
| Browser has no SharedWorker | Window fallback logs in and signs; limitations are handled cleanly |
| Launcher revokes/expires session | Callback clears signer, token, identity, subscriptions, and account caches |
| Explicit game logout | `forgetLauncher: true` clears app and BAL launcher state |
| Page navigation/BFCache | Current tab releases without logging out other attached tabs |
| Stored token belongs to current BAL pubkey | Token is sent and server verifies/rotates it |
| Stored token belongs to another pubkey | Token is deleted; fresh signed challenge is required |
| Malformed/expired token | Client does not trust it; server rejects it |
| Replayed/stale/wrong challenge event | Server rejects it and does not issue a session |
| Feature permission omitted from manifest | Denial is visible and no broader fallback credential is used |
| Production CSP/COOP/COEP | Worker loads, opener handshake survives, no wildcard messaging is introduced |
| Clean dependency install | Lockfile resolves intended SDK commit and one compatible peer implementation |
| Slow/unavailable kind `0` profile relays | Authenticated session becomes usable with fallback display data; profile hydrates later |
| Slow presence/contact/leaderboard services | Login and room entry do not wait for them |
| Directed room link with cold JWKS and BAL | BAL and invite verification start concurrently; join waits for both valid results, not their serial sum |
| Public link to missing lazily-created room | Join-or-create is one atomic request when supported, or the intentional two-round-trip fallback is documented |

Minimum automated assertions:

- adapter creates one coordinator with game-unique keys;
- status subscription observes connect and signer operations;
- rejection and explicit opt-out fall back safely;
- launcher revocation clears game authentication;
- token/pubkey match and mismatch branches are covered;
- same-account, different-account, and failed-replacement branches are covered;
- `getPublicKey()` is resolved once and reused by downstream authentication;
- URL cleanup preserves unrelated query parameters and fragments;
- unresolved profile/presence work does not block login or room entry;
- BAL and invite verification concurrency is asserted with controlled promises rather than wall-clock-only thresholds;
- server validates kind, exact challenge, freshness, signature, and one-use consumption;
- production typecheck and build emit the worker successfully.
