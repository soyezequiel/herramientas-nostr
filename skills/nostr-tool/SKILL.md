---
name: nostr-tool
description: >-
  Agregar login Nostr a una página web sin sufrir los bugs típicos. Cubre los tres
  métodos —NIP-07 (extensión Alby/nos2x), NIP-46 (Nostr Connect por QR o bunker://
  con Amber/Primal/nsec.app) y clave local (nsec)— con sesión que PERSISTE al
  recargar, y token de sesión del lado del servidor para no re-firmar en cada carga.
  Usar cuando el usuario quiera poner "login con Nostr", "iniciar sesión con Nostr",
  auth Nostr, firmar eventos con la clave del usuario, Nostr Connect / QR login,
  bunker, NIP-07/NIP-46, o cuando una sesión Nostr "se cierra al recargar" o "se
  queda en Conectando". El código reutilizable y probado vive en la raíz de ESTE
  repo (paquete nostr-login-tool); esta skill trae el cómo cablearlo y los gotchas.
---

# Login Nostr sin dolor (nostr-tool)

Guía + código para agregar login Nostr a cualquier página. El código reutilizable
—probado en producción— vive **en la raíz de este repo** (`herramientas nostr`,
paquete `nostr-login-tool`): copialo o publicalo. Esta skill es el "por qué" y el
"cómo cablearlo" para no repetir los bugs que ya se resolvieron.

Rutas de código en este repo: `src/` (cliente), `server/` (Node), `examples/login-flow.ts`.

## Primero: ¿tu app tiene servidor autoritativo?

- **App 100% cliente** (la identidad es la pubkey, nada que el server deba validar):
  no necesitás challenge ni token. Login = obtener un signer y `getPublicKey()`.
  Firmás eventos con el signer y listo.
- **Con servidor** que confía en la pubkey (rankings, pagos, salas, etc.): usá el
  login por reto firmado (NIP-42, kind:22242) **+ token de sesión** para no
  re-firmar en cada reload. Es más laburo pero es lo correcto.

## Los tres métodos (ofrecelos todos)

| Método | Para quién | Persiste |
|---|---|---|
| NIP-07 | Desktop con extensión (Alby, nos2x) | sí |
| NIP-46 (QR/bunker) | Celular / firmante remoto (Amber, Primal, nsec.app) | sí |
| Clave local (nsec) | Casual, sin extensión ni firmante | sí |

El paquete trae `createNip07Signer`, `startNostrConnect` (QR), `connectBunker`,
`generateLocalSigner`/`importNsec`, todos devolviendo la misma interfaz `NostrSigner`
(`getPublicKey`, `signEvent`, `nip04/nip44 encrypt/decrypt`). La sesión se persiste
con `setActiveSigner(signer, stored)` y se restaura con `restoreSigner()`.

## El flujo, cableado

Ver `examples/login-flow.ts` (en la raíz del repo) — es el esqueleto completo
(arranque, un método por botón, handshake con el server, logout). No lo reinventes;
adaptá ese.

## ⚠️ GOTCHAS — leé esto ANTES de escribir el login

Cada uno es un bug real que ya está resuelto en el paquete. Si escribís el login a
mano, respetalos o los vas a sufrir en este orden:

1. **La extensión inyecta `window.nostr` async.** Al restaurar la sesión en un
   reload, `window.nostr` todavía no está en el primer tick → si te rendís al
   instante, la sesión "se cierra sola" en cada recarga. **Esperá** con
   `waitForNip07()` (hasta 3s). Este es EL bug más común de "me desloguea al actualizar".

2. **Con servidor: no bloquees la sesión en el firmador.** Si al recargar hacés
   `await signer.getPublicKey()` ANTES de autenticar, y la extensión está bloqueada
   o lenta, te quedás para siempre en "Conectando…". Con token: mandá `auth_token`
   **de una** y restaurá el signer **en segundo plano** (para features que firmen).
   La sesión no debe depender de que la extensión responda.

3. **NIP-46: Amber/Primal usan NIP-04, no NIP-44.** El `BunkerSigner` de
   `nostr-tools` solo habla NIP-44 → contra Amber/Primal la respuesta `connect`
   nunca se descifra y el login "aprueba y no pasa nada". Usá el `Nip46Client`
   incluido (prueba ambos cifrados y fija el que anda). El flujo QR ya lo usa.

4. **NIP-46: permisos por-kind en el URI.** Pedí `sign_event` genérico Y
   `sign_event:<kind>` por cada kind (empezando por 22242). Primal-medium solo
   pre-autoriza lo declarado EXACTO y sin esto se traba. (`nip46Perms` ya lo arma.)

5. **NIP-46 en celu: `SimplePool({ enableReconnect: true })`.** Al abrir el firmante
   por deep link el navegador pasa a background y el SO corta el WS; con reconexión
   la respuesta llega al volver. (Ya está en el cliente.)

6. **No bloquees el login esperando el perfil (kind:0).** Autenticá primero, buscá
   el nombre del perfil en paralelo, y cacheá el resultado (incluido el negativo
   "no tiene perfil") para que los próximos logins no esperen a los relays.

7. **Pantalla "Conectando…": watchdog + salida.** Botón "elegir otro método" +
   timeout (~12s) que vuelve al login si no autenticó. Nunca dejes al usuario
   atrapado si el firmador no responde.

8. **Token estable entre deploys.** En el server, `AUTH_TOKEN_SECRET` (env) hace que
   los tokens sobrevivan a redeploys; sin él, cada reinicio desloguea a todos.
   Generalo con `openssl rand -hex 32`.

9. **Cacheá la pubkey** en la sesión (`updateStoredPubkey`) para saltarte el
   `get_public_key` de NIP-46 (viaja por relays, segundos) en el próximo restore.

10. **(Deploy, no login) "no veo los cambios".** Si servís una SPA: NO metas el
    build-id dentro del bundle JS (cambia el hash y un `index.html` viejo cacheado
    apunta a un bundle borrado → app rota). Poné el build-id en el `index.html` y
    servilo `Cache-Control: no-cache`; los assets hasheados con caché larga.

## Piezas del servidor (Node)

En `server/` (raíz del repo):
- `makeChallenge()` + `verifyChallenge(event, esperado)` → verifica el kind:22242
  firmado (frescura + firma). Devuelve `{pubkey, npub}` o lanza `AuthError`.
- `issueSessionToken(pubkey, extra?)` + `verifySessionToken(token)` → token HMAC
  (JWT-lite, sin libs). Emitilo tras verificar la firma; el cliente lo reusa.

## Checklist de implementación

1. Copiá `nostr-login-tool` (o instalalo). Peers: `nostr-tools` (+ `qrcode` si hay QR).
2. UI de login con solapas: Extensión · QR · Bunker · Clave local (+ invitado si aplica).
3. Cliente: `restoreSigner()` al arrancar; un método por botón; persistí con
   `setActiveSigner`. Ver el ejemplo.
4. ¿Servidor autoritativo? Sumá challenge + token (gotchas 2, 7, 8) y las piezas de
   `server/`. Si no, saltealo: identidad = `getPublicKey()`.
5. Probá el caso crítico: **login → recargar → seguís logueado** (sin re-firmar).
