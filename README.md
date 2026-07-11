# nostr-login-tool

Login **Nostr** reutilizable para cualquier página, con los arreglos de todos los
problemas típicos ya incorporados. Framework-agnóstico (TS/JS de navegador),
depende solo de [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools) (+ `qrcode`
opcional para el QR).

Métodos de login:

| Método | Qué es | Persiste sesión |
|---|---|---|
| **NIP-07** | Extensión del navegador (Alby, nos2x) | ✅ |
| **NIP-46** | Firmante remoto por **QR** o `bunker://` (Amber, Primal, nsec.app) | ✅ |
| **Clave local** | nsec importado o generado en el navegador | ✅ |

Probado en producción (un juego de ajedrez multijugador con servidor autoritativo).
Este paquete es la extracción genérica de ese código.

---

## Instalación

Copiá la carpeta a tu proyecto (o publicala como paquete). Instalá los peers:

```bash
npm install nostr-tools
npm install qrcode        # solo si vas a usar el login por QR
```

Importás del cliente desde `src/` y (opcional) del servidor desde `server/`.

---

## Uso rápido (app 100% cliente, sin backend)

Si tu página no tiene servidor autoritativo, la **identidad es la pubkey**. No hace
falta ni challenge ni token:

```ts
import {
  createNip07Signer, waitForNip07, restoreSigner, setActiveSigner, getActiveSigner,
} from "./src/index.js";

// Al cargar la página: ¿había sesión?
const restored = await restoreSigner();
if (restored) console.log("logueado:", await restored.getPublicKey());

// Botón "Entrar con extensión":
async function loginExtension() {
  if (!(await waitForNip07())) return alert("Instalá Alby o nos2x");
  const signer = createNip07Signer();
  setActiveSigner(signer, { method: "nip07" });     // persiste la sesión
  const pubkey = await signer.getPublicKey();        // tu identidad
}

// En cualquier feature, firmá con el signer activo:
const signer = getActiveSigner()!;
const evt = await signer.signEvent({ kind: 1, created_at: Math.floor(Date.now()/1000), tags: [], content: "gm" });
```

Para QR / bunker / clave local, ver `examples/login-flow.ts`.

---

## Uso con backend autoritativo (recomendado si el server valida algo)

Si tu servidor necesita **confiar** en la pubkey (rankings, pagos, salas), usá el
login por reto firmado (NIP-42) + **token de sesión** para no re-firmar en cada carga:

1. Cliente pide login → server manda un reto (`makeChallenge`) atado a la conexión.
2. Cliente firma un `kind:22242` con el reto (`signAuthChallenge`) y lo devuelve.
3. Server verifica la firma (`verifyChallenge`) → la pubkey es confiable → emite un
   **token** (`issueSessionToken`) y lo manda al cliente.
4. Cliente guarda el token (`writeSessionToken`). En cada reload/reconexión manda el
   token (`auth_token`) en vez de re-firmar. Server lo valida con `verifySessionToken`.

Ver `examples/login-flow.ts` (cliente) y `server/` (Node). El flujo completo,
cableado, está ahí.

---

## ⚠️ Los gotchas (por qué este código y no el "tutorial de 20 líneas")

Cada uno de estos costó un bug real. El código ya los resuelve; esta lista es para
que entiendas **por qué** y no los rompas al adaptarlo.

### 1. La extensión inyecta `window.nostr` de forma ASÍNCRONA
Alby/nos2x setean `window.nostr` un ratito **después** de cargar la página. Si al
restaurar la sesión chequeás `window.nostr` al instante, en cada **reload** está
`undefined` → tu app "cierra la sesión" sola. **Solución:** `waitForNip07()` sondea
hasta 3s. (`restoreSigner` ya lo hace.)

### 2. Con servidor: la sesión NO debe depender del firmador (token primero)
Si al recargar hacés `await signer.getPublicKey()` **antes** de autenticar, y la
extensión está bloqueada o lenta, te colgás para siempre en "Conectando…".
**Solución:** si hay token, mandá `auth_token` **de inmediato** y restaurá el signer
**en segundo plano** (para las features que firmen). La sesión no depende de que la
extensión responda. (Ver `start()` en el ejemplo.)

### 3. NIP-46: Amber/Primal usan NIP-04, no NIP-44
El `BunkerSigner` de `nostr-tools` solo habla NIP-44. Contra Amber/Primal (que por
defecto cifran con NIP-04) la respuesta `connect` **nunca se descifra** y el login
"aprueba y no pasa nada". **Solución:** `Nip46Client` (incluido) prueba ambos
cifrados y fija el que funciona. El flujo QR ya lo usa.

### 4. NIP-46: pedí permisos por-kind en el URI
En el `nostrconnect://`, además de `sign_event` genérico, pedí `sign_event:<kind>`
por **cada kind** que vayas a firmar (empezando por `22242` del login). Firmantes de
confianza "media" (Primal) solo pre-autorizan lo declarado EXACTO y sin esto se
traban al firmar. (Ver `nip46Perms`.)

### 5. NIP-46 en celular: reconexión del pool
Al abrir el firmante por deep link, el navegador pasa a segundo plano y el SO corta
el WebSocket. Usá `new SimplePool({ enableReconnect: true })` (ya está) para que la
suscripción sobreviva y la respuesta llegue al volver.

### 6. No bloquees el login esperando el perfil (kind:0)
Traer el nombre del perfil desde relays puede tardar segundos o nunca responder. No
lo pongas en el camino crítico: autenticá primero, buscá el perfil **en paralelo**, y
cacheá el resultado — incluido el **negativo** ("esta clave no tiene perfil"), para
que los próximos logins tampoco esperen.

### 7. Pantalla "Conectando…": watchdog + salida
Nunca dejes al usuario atrapado. Poné un botón "Elegir otro método" y un timeout
(~12s) que, si no autenticó, vuelva al login. Así, si el firmador no responde, el
usuario no queda colgado.

### 8. Cachés de restore (velocidad)
Guardá la **pubkey** en la sesión (`updateStoredPubkey`) para saltarte el
`get_public_key` de NIP-46 (que viaja por relays, segundos) en el próximo restore.

### 9. `AUTH_TOKEN_SECRET` estable
En el server, seteá `AUTH_TOKEN_SECRET` (env) para que los tokens **sobrevivan a los
redeploys**. Sin él es aleatorio por proceso: cada reinicio desloguea a todos.
Generá uno con `openssl rand -hex 32`.

### 10. (Deploy, no login) "no veo los cambios"
Bonus, causó horas de confusión: si servís una SPA, no metas un build-id **dentro**
del bundle JS (cambia el hash en cada deploy y un `index.html` viejo cacheado apunta
a un bundle borrado → 404 → app rota). Poné el build-id en el `index.html`
(inyectado, no en el bundle) y servilo `Cache-Control: no-cache`; los assets
hasheados sí con caché larga.

---

## API (cliente)

- **Signer:** `NostrSigner` (interfaz), `createNip07Signer`, `createLocalSigner`,
  `generateLocalSigner`, `importNsec`, `waitForNip07`.
- **NIP-46:** `startNostrConnect` (QR), `connectBunker` (bunker://), `nip46Perms`,
  `NIP46_RELAYS`, `Nip46Client`.
- **Sesión:** `restoreSigner`, `setActiveSigner`, `getActiveSigner`,
  `clearActiveSigner`, `hasStoredSigner`, `updateStoredPubkey`, `setStorageKey`.
- **Auth (con server):** `signAuthChallenge`, `readSessionToken`,
  `writeSessionToken`, `clearSessionToken`.

## API (servidor, Node — `server/`)

- `makeChallenge()`, `verifyChallenge(event, expected)` → `{pubkey, npub}` o lanza `AuthError`.
- `issueSessionToken(pubkey, extra?)`, `verifySessionToken(token)` → payload o `null`.

---

## Licencia

MIT.
