# Nostr BAL Browser SDK

Kit autocontenido para agregar **Bunker Auto Login (BAL)** a un juego web. El
juego recibe un signer Nostr compatible con NIP-46 sin ver ni persistir una
`nsec` o una Bunker URI.

Incluye:

- handshake seguro con el launcher mediante `postMessage` y origen exacto;
- cliente NIP-46 dentro de un `SharedWorker`;
- reutilización de una única sesión desde varias pestañas del mismo origen;
- continuidad si se cierra la pestaña que hizo el handshake inicial;
- fallback a `BalGameClient` cuando el navegador no soporta `SharedWorker`;
- opt-out explícito mediante `?lnBal=off`;
- estados de conexión listos para una navbar o indicador de actividad.

## Instalación

Desde `ajedrez/web`, mientras se desarrolla junto a este repositorio:

```bash
npm install "file:../../herramientas nostr"
```

Una vez publicado el repositorio, cualquier juego puede instalarlo sin copiar
fuentes:

```bash
npm install github:soyezequiel/herramientas-nostr
```

El juego debe usar `nostr-game-protocol >=0.6` y `nostr-tools >=2.23.9`. El SDK
los declara como `peerDependencies` para compartir una única implementación con
el juego y evitar duplicar clientes o tipos Nostr.

El launcher debe implementar BAL v1, registrar la ventana exacta del juego y
abrirlo con:

```text
https://juego.example/?lnOrigin=https%3A%2F%2Fluna.example
```

Con Luna Negra, el `gameId` debe coincidir con el slug y los permisos deben
coincidir exactamente con el manifiesto autorizado por la tienda.

## Integración

El juego sólo necesita un entry local para que su bundler emita el
`SharedWorker`. Con Vite, creá `bal-worker.ts`:

```ts
import "nostr-bal-browser-sdk/worker";
```

Después configurá el SDK en un adaptador del juego:

```ts
import { createBalBrowserLogin } from "nostr-bal-browser-sdk";

const bal = createBalBrowserLogin({
  gameId: "mi-juego",
  gameName: "Mi Juego",
  permissions: [
    "get_public_key",
    "sign_event:1",
    "sign_event:22242",
    "nip44_encrypt",
    "nip44_decrypt",
  ],
  launcherOriginStorageKey: "mi-juego.bal.launcher-origin.v1",
  shared: {
    // El constructor queda en el juego para funcionar con su bundler.
    createWorker: () => new SharedWorker(
      new URL("./bal-worker.ts", import.meta.url),
      { type: "module", name: "mi-juego-bal-v1" },
    ),
    activeHintKey: "mi-juego.bal.shared-active.v1",
  },
});

export default bal;
```

No reutilices las claves de storage ni el nombre del worker entre juegos. El
SDK no incorpora datos de ningún juego: toda identidad entra por esta
configuración.

## Inicio

Intentá BAL antes del login propio del juego:

```ts
const signer = await bal.connect(
  () => {
    // Luna revocó o cerró BAL: invalidar la sesión local del juego.
    clearGameSession();
    showLogin();
  },
  () => {
    // El consentimiento está visible en Luna.
    showContinueInLauncherNotice();
  },
);

if (signer) {
  const pubkey = await signer.getPublicKey();
  await authenticateGameServer(pubkey, signer);
} else {
  showNormalLogin();
}
```

El signer expone:

```ts
signer.getPublicKey();
signer.signEvent(template);
signer.nip04Encrypt(pubkey, plaintext);
signer.nip04Decrypt(pubkey, ciphertext);
signer.nip44Encrypt(pubkey, plaintext);
signer.nip44Decrypt(pubkey, ciphertext);
```

El servidor del juego debe autenticar la pubkey con un challenge firmado, por
ejemplo un evento `kind:22242`. Nunca confíes solamente en una pubkey recibida
desde el browser.

## Restauración de tokens

Si el juego guarda un token de sesión, verificá que ese token pertenezca a la
pubkey BAL actual antes de restaurarlo. Una pestaña con nombre puede conservar un
token de otra cuenta del launcher.

```ts
if (token && bal.hasLauncherContext()) {
  const signer = await bal.connect(onLogout);
  const pubkey = signer && await signer.getPublicKey();
  if (!pubkey || !tokenBelongsToPubkey(token, pubkey)) clearToken();
}
```

## Cierre

```ts
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void bal.logout();
});

// Logout explícito del jugador:
await bal.logout({ forgetLauncher: true });
```

`logout()` libera únicamente la pestaña actual. Si quedan otras pestañas, el
`SharedWorker` y NIP-46 continúan. Al cerrarse la última pestaña, el worker libera
su cliente local y envía el `logout` NIP-46 para que el launcher cierre también
el signer remoto.

## Estado para UI

```ts
const unsubscribe = bal.subscribeStatus(({ phase, detail }) => {
  renderBalStatus(phase, detail);
});
```

Las fases posibles están tipadas como `BalSignerPhase`.

## Seguridad y despliegue

- Nunca guardes `bunkerUri`, secrets o claves efímeras en storage o en la URL.
- Conservá `targetOrigin` exacto; nunca uses `"*"`.
- Solo páginas del mismo origen pueden conectarse al `SharedWorker`.
- Serví el worker desde el mismo origen del juego.
- Si usás `SharedArrayBuffer`, `COOP: restrict-properties` conserva el opener BAL
  sin abandonar `COEP: require-corp` en navegadores compatibles.
- Con CSP, permití el worker desde `'self'` mediante `worker-src 'self'`.
- `?lnBal=off` siempre prevalece aunque exista otro worker activo.

## Pruebas mínimas

1. Abrir desde el launcher y completar BAL.
2. Abrir la URL limpia directamente en otra pestaña.
3. Firmar desde ambas y comprobar que existe una sola sesión BAL.
4. Cerrar la pestaña lanzada y volver a firmar desde la directa.
5. Cerrar la última pestaña y confirmar que una apertura directa usa el login normal.
6. Probar revocación, expiración, `lnBal=off` y navegador sin `SharedWorker`.
