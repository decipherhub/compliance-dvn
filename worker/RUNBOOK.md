# Compliance DVN Worker — Operations Runbook

The worker is a LayerZero **Compliance DVN**: it screens cross-chain OFT transfers against
sanctions denylists (OFAC, OpenSanctions, curated mixers, operator test entries) and
**withholds verification** for transfers involving flagged addresses. It is **fail-closed**:
on any uncertainty it withholds rather than risk approving a sanctioned transfer.

## Architecture at a glance

- `runtime/config.ts` — zod-validated env → typed config; fails fast at boot.
- `runtime/denylist-manager.ts` — builds/refreshes the denylist; owns the fail-closed state machine.
- `runtime/scanner.ts` — per-chain scan + per-packet verify/veto (freezes checkpoints when not READY).
- `runtime/tx-sender.ts` — nonce tracking, gas escalation, bounded retries.
- `runtime/http.ts` — `/healthz` `/readyz` `/metrics`.
- `runtime/lifecycle.ts` — graceful shutdown.
- `service.ts` — composes the above into the poll loop.

## States (see `dvn_ready`, `dvn_halted`)

| State | Meaning | `/readyz` | Verifying? |
|---|---|---|---|
| INITIALIZING | Building the first denylist (retries with backoff) | 503 | no |
| READY | Normal operation | 200 | yes |
| REFRESHING | Transient, during a denylist refresh | 200 | yes (old list still fresh) |
| HALTED | Denylist stale or refresh failed past staleness | 503 | **no — withholding all** |

**Checkpoints freeze while HALTED**: the scan window does not advance, so every packet during
the halt is screened once the worker recovers. Expect a short backlog spike on recovery.

## Run locally

```bash
cp worker/.env.example worker/.env   # fill OPERATOR_PRIVATE_KEY + DVN_* addresses
pnpm worker                          # from the repo root; or cd worker, then pnpm start
```

Held packets, screening results, and owner actions (approve / reject) live in the demo dashboard —
`demo/dashboard/` — or the worker's own HTTP surface (`/status`, `/pending`).

Health: `curl localhost:9090/healthz` · `:9090/readyz` · `:9090/metrics`.

## Deploy (Kubernetes)

```bash
docker build -t ghcr.io/your-org/compliance-dvn-worker:<tag> worker/
# Create the Secret out-of-band (never commit it):
kubectl create secret generic compliance-dvn-worker-secrets \
  --from-literal=OPERATOR_PRIVATE_KEY=0x... \
  --from-literal=DVN_BASE_SEPOLIA=0x... --from-literal=DVN_OPTIMISM_SEPOLIA=0x...
kubectl apply -k worker/deploy/k8s/          # set the image tag in kustomization.yaml first
```

Import `worker/deploy/grafana-dashboard.json` into Grafana (pick your Prometheus datasource). For a
local stack, `docker compose --profile observability up -d` in `indexer/` provisions this dashboard
too, scraping the worker at `host.docker.internal:9090`.

> **Single replica only.** The checkpoint file and local nonce tracking assume one writer.
> The Deployment pins `replicas: 1` with `strategy: Recreate`. Do not scale up.

## Alert response

### `DvnHalted` (critical) — the worker is withholding ALL verification
1. Check `dvn_halted{reason}` and recent logs. Reason `stale_denylist` ⇒ refreshes have been
   failing long enough that the list aged past `MAX_DENYLIST_STALENESS_MS`.
2. Look at `dvn_denylist_refresh_total{result="failure"}` and logs for the upstream error
   (OFAC GitHub list / OpenSanctions endpoint unreachable, parse failure, etc.).
3. Fix connectivity/egress. The next successful refresh auto-recovers the worker to READY.
4. If a source is down for an extended period and you accept the risk, you may *temporarily*
   raise `MAX_DENYLIST_STALENESS_MS` — this widens the window in which the last good list is
   trusted. **This trades strictness for availability; record the decision.**

### `DvnRefreshFailing` / `DvnDenylistStale` (warning)
Refreshes are failing but the list is still within the staleness window. Investigate the
upstream source before it ages out and trips `DvnHalted`.

### `DvnVerificationFailing` (warning)
On-chain `submitVerification` failures on a chain. Check, in order:
- signer balance (gas) on that chain — top up the operator key;
- RPC health (`dvn_scan_errors_total`, provider status);
- whether the packet was actually `JobAssigned` to our DVN.
The worker retries failed verifications on the next scan; checkpoints are not advanced past
an unprocessed assigned packet.

### `DvnNotReady` / `DvnScanErrors` (warning)
Worker stuck INITIALIZING (initial build failing) or RPC scan errors. Check egress to the
sanctions sources and RPC endpoints.

## Key rotation

1. Fund the new operator address on every enabled chain.
2. Ensure the new address is authorized to call `submitVerification` on each ComplianceDVN
   (and `commitVerification` on the ReceiveUln, which is permissionless).
3. Update `OPERATOR_PRIVATE_KEY` in the Secret; `kubectl rollout restart deploy/compliance-dvn-worker`.
4. Local nonce tracking re-syncs from the chain on the next send — no manual nonce reset needed.

## Recovery / data

- Checkpoint lives at `CHECKPOINT_PATH` (`/data/dvn-checkpoint.json` in-cluster, on the PVC).
- Writes are atomic (temp file + rename), so a crash mid-write cannot corrupt it.
- To force a re-scan from a given height, stop the worker, edit `lastBlock` in the checkpoint,
  restart. Deleting the checkpoint backfills `SCAN_BACKFILL_BLOCKS` from the safe head
  (older history is not re-screened).

## Tuning reference

See `worker/.env.example` for every variable. Most-changed in production:
`POLL_MS`, `DVN_CONFIRMATIONS`, `DENYLIST_REFRESH_MS`, `MAX_DENYLIST_STALENESS_MS`,
`TX_MAX_RETRIES`, `TX_GAS_BUMP_PCT`, `LOG_LEVEL`.
