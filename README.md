# arkade-p2pd

Daemon local de Arkade P2P. Custodia la wallet, habla con Nostr y Arkade, y
persiste el estado de las operaciones para que el cliente web sea una simple
vista. El navegador nunca ve el mnemónico.

## Componentes

- **Wallet** cifrada con scrypt + AES-256-GCM; estados `uninitialized`, `locked`
  y `unlocked`.
- **Nostr**: pool de relays con reconexión, deduplicación, consultas one-shot,
  suscripciones estables y cola de salida persistente.
- **SQLite + Drizzle**: `operations`, `messages`, `escrows`, `disputes`,
  `ratings`, `relays`, `outbox`, `cursors` y `settings`, con migraciones
  versionadas al arrancar.
- **Monitor de trades**: recalcula las ventanas de 15 minutos desde los mensajes
  persistidos y expone el estado sin depender del navegador.
- **Recuperación**: al arrancar lista operaciones activas, escrows y disputas.
- **RPC WebSocket** en `127.0.0.1:9100` con allowlist de `Origin`.

## Requisitos

- Node.js 20 o superior.
- Linux/macOS (probado en Linux). `better-sqlite3` compila de forma nativa.

## Instalación y arranque

```bash
npm install
cp settings.tpl.toml settings.toml
npm run dev        # desarrollo con tsx watch
# o
npm run build
npm start          # node dist/main.js
```

Al arrancar imprime la ruta de la DB, la versión de esquema y el estado de la
wallet. Sin wallet, queda en `uninitialized` y el cliente ofrece crearla o
importarla.

## Configuración

Orden de precedencia: valores por defecto → `settings.toml` →
variables de entorno. Un TOML malformado aborta el arranque en vez de usar
defaults silenciosamente.

`settings.toml` (copia de `settings.tpl.toml`):

```toml
[daemon]
host = "127.0.0.1"
port = 9100
allowedOrigins = ["http://localhost:5173", "https://tu-usuario.github.io"]

[db]
path = "./data/daemon.db"

[nostr]
relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]

[arkade]
network = "mutinynet"

[wallet]
path = "./data/wallet.json"
```

Variables de entorno:

| Variable | Equivale a | Ejemplo |
| --- | --- | --- |
| `DAEMON_CONFIG_PATH` | ruta del TOML | `/etc/arkade-p2pd/settings.toml` |
| `DAEMON_HOST` | `daemon.host` | `127.0.0.1` |
| `DAEMON_PORT` | `daemon.port` | `9100` |
| `DAEMON_ALLOWED_ORIGINS` | `daemon.allowedOrigins` (coma) | `https://ui.example` |
| `DAEMON_DB_PATH` | `db.path` | `./data/daemon.db` |
| `DAEMON_RELAYS` | `nostr.relays` (coma) | `wss://a,wss://b` |
| `ARKADE_NETWORK` | `arkade.network` | `mutinynet` |
| `WALLET_PATH` | `wallet.path` | `./data/wallet.json` |

La wallet se guarda como `<path>.enc.json` (por ejemplo
`data/wallet.enc.json`). Es un blob cifrado: sin la passphrase no se puede
recuperar.

## RPC

WebSocket JSON-RPC en `ws://127.0.0.1:9100`. Cada mensaje lleva `id`, `method`
y `params`; la respuesta repite `id` con `result` o `error`.

| Grupo | Métodos |
| --- | --- |
| Wallet | `wallet.status`, `wallet.create`, `wallet.import`, `wallet.unlock`, `wallet.getIdentity` |
| Firma | `nostr.signEvent`, `nostr.wrapDm`, `nostr.unwrapDm`, `nostr.nip44Encrypt`, `nostr.nip44Decrypt`, `wallet.signPsbt(s)`, `wallet.signMessage`, `wallet.signSchnorrDeterministic` |
| Relays | `relays.list`, `nostr.publish`, `nostr.query`, `nostr.subscribe`, `nostr.unsubscribe` |
| Estado | `operations.*`, `messages.*`, `escrows.*`, `disputes.*`, `ratings.*`, `settings.*`, `cursors.*` |
| Motor | `trading.status`, `recovery.status`, `session.state` |

`session.state` devuelve un resumen para diagnóstico: estado de wallet, relays,
operaciones, escrows, disputas, trades y recuperación.

## Backups y restauración

Copia en frío (daemon detenido) de:

1. `data/daemon.db` (y `-wal`/`-shm` si existen).
2. `data/wallet.enc.json`.
3. `settings.toml` (sin secretos; la passphrase no se guarda).

Restauración: detén el daemon, repón los tres archivos en sus rutas, arranca y
desbloquea la wallet. Verifica con `session.state` que aparecen las operaciones
activas y los relays esperados.

## Servicio del sistema (systemd)

```ini
[Unit]
Description=arkade-p2pd
After=network-online.target

[Service]
Type=simple
User=arkade
WorkingDirectory=/opt/arkade-p2pd
Environment=DAEMON_CONFIG_PATH=/etc/arkade-p2pd/settings.toml
ExecStart=/usr/bin/node /opt/arkade-p2pd/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

El daemon no guarda la passphrase: tras un reinicio queda `locked` hasta que el
cliente lo desbloquee.

## Operación

- **Logs**: salida estándar con prefijos `[arkade-p2pd]`, `[wallet]`,
  `[nostr]`, `[trading]`. No registran mnemónicos, passphrases ni contenido de
  DMs.
- **Salud**: `session.state` es la fuente de verdad para diagnosticar.
- **Actualización**: detén el servicio, haz backup, `git pull`, `npm install`,
  `npm run build`, arranca. Las migraciones se aplican solas.
- **Red**: mantén el RPC en loopback. Si lo expones, usa TLS y una allowlist
  estricta; cualquier origen permitido puede pedir firmas.

## Pruebas

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Runbook de incidentes: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
Runbook de escrow del cliente:
[`arkade-p2p-nostr/docs/ESCROW_RUNBOOK.md`](https://github.com/Delgado74/arkade-p2p-nostr/blob/main/docs/ESCROW_RUNBOOK.md).
