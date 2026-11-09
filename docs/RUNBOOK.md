# Runbook de incidentes — arkade-p2pd

Guía operativa para diagnosticar y recuperar el daemon. Usa `session.state`
(por RPC o desde la UI) como primera fuente de verdad. **Nunca** registres ni
pegues en un issue el mnemónico, la passphrase, `wallet.enc.json` ni el
contenido de DMs.

## Diagnóstico rápido

```bash
# ¿Está vivo?
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9100 || true

# Logs si corre como servicio
journalctl -u arkade-p2pd -n 200 --no-pager

# Estado de la DB
sqlite3 data/daemon.db 'select status, count(*) from operations group by status;'
sqlite3 data/daemon.db 'select count(*) from messages;'
sqlite3 data/daemon.db 'select * from settings;'
```

Desde la UI, `session.state` debe mostrar la wallet `unlocked`, relays con
salud, y las operaciones/escrows/disputas esperadas.

## 1. Relay caído o suscripción muerta

**Síntomas**: no entran DMs nuevos, `relays.list` marca relays caídos, el feed
se congela pero la DB conserva el historial.

1. Comprueba conectividad (`wscat -c wss://relay...` o `curl -I https://...`).
2. Añade relays alternativos en `settings.toml` (`[nostr] relays`) o
   `DAEMON_RELAYS`, y reinicia el daemon.
3. Verifica que los relays nuevos se solapan con los del coordinador y la
   contraparte.
4. Los mensajes ya persistidos se leen de SQLite; no se pierden por un relay
   caído. La cola `outbox` reintenta publicaciones pendientes.

No borres `outbox` para “arreglar” un relay: perderías eventos firmados sin
publicar.

## 2. ASP / Arkade caído

**Síntomas**: el cliente no deriva direcciones ni consulta VTXOs; los escrows
quedan en `pending`.

1. Comprueba el ASP configurado (`VITE_ARK_OPERATOR` en el cliente,
   `arkade.network` en el daemon).
2. No fondees ni liberes mientras el indexer no responda: el estado del VTXO no
   se puede clasificar.
3. Si el escrow ya está `spendable`, la liberación cooperativa no depende del
   ASP salvo para el broadcast; espera y reintenta.
4. Si el ASP cambió de red, **no** migres la wallet a ciegas: los VTXOs de otra
   red no son recuperables con las mismas claves.

## 3. Escrow barrido (`recoverable`)

**Síntoma**: el VTXO del escrow aparece `recoverable` o `swept`; liberar,
reembolsar o disputar falla a propósito.

1. No intentes gastar el escrow barrido por la vía normal.
2. Ejecuta el flujo de recuperación de `arkade-p2p-nostr/docs/ESCROW_RUNBOOK.md`
   (sección de barrido) con la wallet desbloqueada.
3. Si la recuperación no encuentra el VTXO, revisa que el indexer sea el mismo
   y que el `refundLocktime` del acuerdo ya haya madurado.
4. Registra el `txid`/`vout` y el `orderId`; el estado queda en `escrows`.

## 4. Disputa atascada

**Síntomas**: hay `DisputeAnnounce` pero ningún `DisputeTake` válido, o la
resolución no aparece.

1. Confirma que el solver está en el registro del coordinador y que el take
   referencia el **event id** del anuncio (no el `orderId`).
2. Revisa que el take sea del solver ganador y del anuncio vigente (el último
   por orden).
3. Si el solver perdió la carrera, no republica el mismo take: publica uno
   nuevo con `created_at` posterior solo si la UI lo permite.
4. Sin solver disponible, la salida es la cancelación cooperativa o el reembolso
   por timelock; nunca liberes fuera de las reglas del escrow.

## 5. Wallet bloqueada tras reiniciar

El daemon no almacena la passphrase. Tras un reinicio queda `locked`:

1. Abre el cliente y desbloquea la wallet.
2. Comprueba `wallet.status` → `unlocked` y `session.state`.
3. Si la passphrase se perdió, **no** hay recuperación: el blob cifrado no se
   puede descifrar. Restaura `wallet.enc.json` desde el backup y la passphrase
   desde tu gestor de secretos.

## 6. Pérdida de dispositivo

1. Restaura en un equipo limpio: instala el daemon, repón
   `data/wallet.enc.json`, `data/daemon.db` y `settings.toml`.
2. Arranca y desbloquea con la passphrase.
3. Verifica identidad (`wallet.getIdentity`) contra el npub conocido.
4. Las operaciones activas aparecen en `recovery.status`; no las reinicies a
   mano hasta confirmar el estado del escrow en el indexer.
5. Si el dispositivo se perdió y la passphrase estaba solo en él, considera la
   wallet comprometida: mueve fondos y publica un nuevo registro de solvers si
   eras coordinador.

## 7. DB corrupta o migración fallida

1. Detén el daemon inmediatamente.
2. Copia `data/daemon.db`, `-wal` y `-shm` a un directorio seguro.
3. Intenta `sqlite3 data/daemon.db 'pragma integrity_check;'`.
4. Si falla, restaura el último backup verificado. No edites tablas a mano sin
   copia previa.
5. Si el fallo es de migración, arranca con la versión anterior, exporta
   (`operations.import`/`messages.import`) y vuelve a actualizar.

## 8. El RPC rechaza el origen

**Síntoma**: el cliente no conecta; el daemon registra un origen no permitido.

1. Añade el origen exacto (esquema + host + puerto) a `DAEMON_ALLOWED_ORIGINS`.
2. Reinicia el daemon.
3. No uses `*`: cualquier origen permitido puede solicitar firmas y descifrado.

## Checklist de cierre de incidente

- `session.state` coherente (wallet, relays, operaciones).
- `pragma integrity_check` en SQLite sin errores.
- Backup nuevo de DB y wallet.
- Log del incidente sin secretos, con `orderId`, `event id`, `txid` y hora.
