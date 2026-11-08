# AGENTS.md — arkade-p2pd

## Descripción

Daemon local en TypeScript para Arkade P2P sobre Nostr. Es el límite de
confianza: custodia la wallet, deriva claves, firma eventos Nostr/PSBT y expone
un RPC WebSocket en `127.0.0.1` para que el cliente web nunca maneje secretos.

## Arquitectura

- `src/main.ts`: arranque de configuración, DB, wallet, Nostr, trading, recovery
  y RPC.
- `src/config/index.ts`: defaults y variables de entorno. `settings.tpl.toml` es
  la plantilla; el parser actual solo aplica defaults y `DAEMON_ALLOWED_ORIGINS`,
  no asumir que todas las secciones TOML ya se leen.
- `src/wallet/index.ts`: ciclo de vida de wallet (`uninitialized`, `locked`,
  `unlocked`), identidad Nostr, firma de eventos, NIP-17/NIP-44 y firma Ark.
- `src/utils/mnemonic.ts`: derivación de claves desde mnemónico (Nostr x-only y
  Ark compressed).
- `src/utils/keystore.ts`: cifrado de keystore con scrypt + AES-256-GCM.
- `src/utils/crypto.ts`: utilidades criptográficas compartidas.
- `src/rpc/server.ts`: servidor JSON-RPC WebSocket y allowlist de orígenes.
- `src/db/`: SQLite + Drizzle. Esquema completo (`operations`, `messages`,
  `escrows`, `disputes`, `ratings`, `relays`, `outbox`, `cursors`, `settings`),
  migraciones versionadas en `src/db/migrations.ts` e inicialización en
  `openDb()`. El repositorio de operaciones vive en `src/db/operations.ts`.
- `src/escrow/`: tipos y validación de acuerdos de escrow.
- `src/nostr/`, `src/trading/`, `src/recovery/`: esqueletos de servicios del
  daemon; hoy principalmente logging/arranque.

## Comandos

```bash
npm install
npm run dev        # tsx watch src/main.ts
npm run build      # tsc -p tsconfig.json
npm start          # node dist/main.js
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint src
```

Antes de cerrar un cambio ejecutar:

```bash
npm run typecheck && npm run lint && npm run build
```

No hay suite de tests propia todavía; si se añade, documentar el comando aquí y
en `package.json`.

## Configuración

- Copiar `settings.tpl.toml` a `settings.toml` para desarrollo local.
- `settings.toml`, `data/`, `dist/`, `node_modules/`, `.idea/` y logs están
  ignorados.
- Variables relevantes:
  - `DAEMON_ALLOWED_ORIGINS`: lista separada por comas; reemplaza los orígenes
    por defecto.
  - `DAEMON_DB_PATH`: ruta del archivo SQLite; por defecto `./data/daemon.db`.
- Por defecto el RPC escucha en `ws://127.0.0.1:9100`.
- La wallet cifrada se guarda junto a `wallet.path` con sufijo `.enc.json`.
- Al arrancar se aplican las migraciones pendientes y se registran en
  `schema_migrations`.

## RPC

Métodos principales en `src/rpc/server.ts`:

- `wallet.status`, `wallet.create`, `wallet.import`, `wallet.unlock`
- `wallet.getIdentity`, `nostr.getIdentity`
- `nostr.signEvent`, `nostr.wrapDm`, `nostr.unwrapDm`
- `nostr.nip44Encrypt`, `nostr.nip44Decrypt`
- `ark.getPublicKey`
- `ark.signPsbt`, `ark.signPsbts`
- `ark.signMessage`, `ark.signSchnorrDeterministic`
- `operations.list` (`limit`), `operations.get` (`orderId`)
- `operations.upsert` (`orderId`, `patch`), `operations.delete` (`orderId`)
- `operations.import` (`operations[]`, idempotente: las filas existentes ganan)

Los métodos `operations.*` no requieren wallet desbloqueada; solo la DB. El
resto sí requiere wallet disponible.

Mantener los nombres y formas de parámetros sincronizados con
`arkade-p2p-nostr/src/lib/daemon/client.ts` e `identity.ts`.

## Seguridad

- El daemon es el único que puede ver el mnemónico o firmar. Nunca enviar
  secretos por RPC ni incluirlos en respuestas.
- No registrar mnemónicos, `nsec`, claves derivadas, macaroons, PSBTs completos
  ni payloads descifrados.
- El RPC se protege solo por `Origin`: por defecto escucha en loopback y rechaza
  orígenes no listados. No abrir `0.0.0.0` sin una capa de autenticación.
- Una UI HTTPS no puede conectarse a `ws://127.0.0.1:9100` por mixed content;
  documentar/implementar el transporte seguro antes de un despliegue real.
- Validar cada parámetro RPC antes de usarlo; no confiar en el cliente.
- Mantener el keystore cifrado (scrypt + AES-256-GCM) y no escribir el
  mnemónico en claro en disco.
- Cambios en derivación de claves o firma Ark deben coordinarse con los tests del
  cliente (`identity.test.ts`).

## Convenciones

- ESM, TypeScript estricto, comillas dobles y punto y coma.
- Imports internos con extensión `.js` (NodeNext).
- Mantener separación por módulos (`wallet`, `rpc`, `db`, `escrow`, etc.).
- Errores claros y accionables; no silenciar fallos de wallet o firma.
- No añadir dependencias nuevas sin revisar que el cliente/coordinador no
  impongan otra versión incompatible.

## Git

- Commits convencionales: `feat(...)`, `fix(...)`, `test(...)`, `chore(...)`.
- No commitear secretos, `settings.toml`, `data/`, `dist/`, `.idea/` ni
  artefactos de build.
- No hacer `push` ni `force-push` sin que el usuario lo pida explícitamente.
