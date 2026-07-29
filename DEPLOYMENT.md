# Deployment — testnet

Ordered sequence for bringing up the contracts, the indexer, and the worker. The order matters:
each step produces a value the next one needs, and two of the steps are hard to undo.

For day-2 operations (alerts, key rotation, recovery) see [worker/RUNBOOK.md](worker/RUNBOOK.md).

## Keys

Three distinct keys. Keeping them separate is not hygiene, it is the design:

| Key                  | Held by             | Purpose                                                     | Must be funded   |
| -------------------- | ------------------- | ----------------------------------------------------------- | ---------------- |
| **owner / deployer** | a human             | deploys, and calls `approvePacket` to release held packets  | yes, both chains |
| **operator**         | the worker process  | `submitVerification`, `commitVerification`, `recordVerdict` | yes, both chains |
| **feed signer**      | the indexer process | signs published feeds                                       | no               |

`approvePacket` is `onlyOwner` precisely so the worker cannot release the packets it chose to
withhold. If owner and operator are the same key, that protection is gone — the worker could
approve its own holds. The deploy script warns when they collapse.

The owner key belongs in the CLI environment as `OWNER_PRIVATE_KEY`, **never** in the worker's
environment.

## 1. Root environment

```bash
cp .env.example .env
```

Set in `.env`:

- `PRIVATE_KEY` — the **owner/deployer** key (this is what hardhat deploys from)
- `OPERATOR_ADDRESS` — the worker key's _address_ (not its private key)
- `RPC_URL_BASE_SEPOLIA`, `RPC_URL_OPTIMISM_SEPOLIA` — override the public defaults if you have
  your own endpoints; public RPCs rate-limit and the indexer polls continuously

Leave `DVN_BASE_SEPOLIA` and `DVN_OPTIMISM_SEPOLIA` empty for now — they are outputs of step 3.

## 2. Preflight

```bash
npx hardhat dvn:preflight --network base-sepolia
```

```bash
npx hardhat dvn:preflight --network optimism-sepolia
```

Checks the signer resolves, the RPC answers, the deployer is funded, the ReceiveUln is known, and
whether an existing deployment is compatible. Sends no transactions. Fix every `ERROR` and read
every `WARN` before continuing.

## 3. Deploy the DVN

Both chains. `OPERATOR_ADDRESS` must be set or owner and operator collapse.

```bash
npx hardhat deploy --network base-sepolia --tags ComplianceDVN
```

```bash
npx hardhat deploy --network optimism-sepolia --tags ComplianceDVN
```

Then put the two addresses into `.env` as `DVN_BASE_SEPOLIA` and `DVN_OPTIMISM_SEPOLIA`.

> A previously deployed ComplianceDVN cannot be reused. `submitVerification` gained verdict
> parameters and the contract is not upgradeable, so the old address exposes a different ABI.
> `dvn:preflight` detects this and says so.

## 4. Wire the pathway

This is the step that tells the ULN which DVN each pathway **requires**.

```bash
npx hardhat lz:oapp:wire --oapp-config layerzero.config.ts
```

`layerzero.config.ts` throws if either `DVN_*` is unset rather than defaulting to a placeholder —
wiring a zero address succeeds silently and then every message on that pathway is permanently
unverifiable, because the required DVN has no code to verify with.

Confirm both sides:

```bash
npx hardhat dvn:status --network base-sepolia
```

Check `operator` is the worker address and `owner` is yours.

## 5. Indexer

```bash
cd indexer
cp .env.example .env
```

Set:

- `FEED_SIGNING_KEY` — a fresh key, used only for signing. Note its **address**; the worker needs it.
- `DVN_BASE_SEPOLIA`, `DVN_OPTIMISM_SEPOLIA` — from step 3
- `TRACKED_TOKENS` — the ERC-20s whose transfers build the graph. **Empty means no edges**, so the
  feed will be valid, signed, and empty.
- `TOKEN_MINIMUMS` — `chain:token:minValue` per token, in the token's smallest unit. **Without an
  entry a token never produces an inbound label**, so leaving this empty turns
  `sanctions_1hop_inbound` off entirely. Outbound labels are unaffected.
- `POLICY_VERSION` — must equal the worker's `POLICY_VERSION` in `worker/assess/policy.ts` (currently `1`)

```bash
docker compose up -d
```

Migrations run at boot. Verify:

```bash
curl -s localhost:9091/feed/latest.json | head -c 400
```

A `503 no feed published yet` is expected until the first build (`FEED_REBUILD_MS`, default 10 min).
Check the logs for the boot warnings — they name any tracked token missing a threshold.

Get the signer address for the next step:

```bash
docker compose logs indexer | grep -i "indexer feed\|signer"
```

## 6. Worker

```bash
cd worker
cp .env.example .env
```

Set:

- `OPERATOR_PRIVATE_KEY` — the **operator** key (funded on both chains). The name differs from
  the root `.env` deliberately: the worker rejects a bare `PRIVATE_KEY` and explains why, so
  copying the root file here fails loudly instead of granting owner rights.
- `DVN_BASE_SEPOLIA`, `DVN_OPTIMISM_SEPOLIA` — from step 3
- `INDEXER_FEED_URL` — e.g. `http://<indexer-host>:9091/feed/latest.json`
- `INDEXER_SIGNERS` — the indexer's signer **address**. The worker refuses to boot with a feed URL
  and no allowlist: ingesting unverified labels is worse than having none.
- `EMIT_VERDICT_EVENTS` — `block` by default, which means each veto costs a `recordVerdict`
  transaction. Set it empty to record only `allow` (which rides along on `submitVerification` for
  free).
- `TEST_DENYLIST` — an address you hold a key for, if you want to demo a veto

Do **not** set `OWNER_PRIVATE_KEY` here.

```bash
pnpm start
```

```bash
curl -s localhost:9090/readyz
```

The worker refuses to verify anything until it has a fresh risk store, so `readyz` failing at
first is the fail-closed design working, not a fault.

## 7. Smoke test

Send a clean transfer and watch it settle. `demo:send` is the convenience wrapper:

```bash
npx hardhat demo:send --network base-sepolia --dst opt --to 0x<recipient> --amount 1
```

Or the full LayerZero task, which takes explicit eids rather than a network:

```bash
npx hardhat lz:oft:send --src-eid 40245 --dst-eid 40232 --to 0x<recipient> --amount 1
```

The worker log should show `VERIFY submitted` then `COMMIT driven`. Or screen a specific
transaction without sending:

```bash
pnpm cli verify baseSepolia 0x<txhash> --dry-run
```

Then exercise a veto by putting a held address in `TEST_DENYLIST` and sending from it — expect
`VETO — withholding verification` and no delivery.

To exercise the manual-review path, set `OWNER_PRIVATE_KEY` in your **shell** (not the worker's
env) and:

```bash
pnpm cli pending
```

```bash
pnpm cli approve optimismSepolia 0x<payloadHash>
```

## Cross-checks that bite later

- **Operator gas on both chains.** `submitVerification` and `commitVerification` run on the
  _destination_ chain, so a bidirectional pathway needs the operator funded on both.
- **`POLICY_VERSION` must match** between worker code and indexer env. A mismatched feed is
  rejected whole, not reconciled — scores computed under different weights are not comparable.
- **Feed TTL vs rebuild interval.** `FEED_TTL_SEC` must exceed `FEED_REBUILD_MS` or a document can
  expire before its replacement exists and screening flaps. Config enforces this.
- **Staleness vs refresh.** `MAX_DENYLIST_STALENESS_MS >= DENYLIST_REFRESH_MS`, likewise enforced.
- **`DEGRADED_MODE`.** Default `degrade` keeps verifying on OFAC/OpenSanctions alone when the feed
  is unavailable. `halt` withholds everything instead. Decide deliberately.
- **Sourcify v1 is in a brownout.** The indexer targets v2; if you point `VERIFIER_URL` at a
  self-hosted instance, make sure it serves `/v2/contract/{chainId}/{address}`.

## Dashboards

For a local stack, the indexer's compose file brings up Prometheus and Grafana with both dashboards
and both datasources already provisioned:

```bash
docker compose --profile observability up -d
```

Grafana on <http://localhost:3000> (loopback only, anonymous viewer). See
[indexer/README.md](indexer/README.md) for what the panels mean.

To wire them into existing monitoring instead, import:

- `worker/deploy/grafana-dashboard.json` — Prometheus only
- `indexer/deploy/grafana-dashboard.json` — needs both Prometheus and the indexer's Postgres;
  the audit trail lives in Postgres and is deliberately not exported as metrics

Both pin their datasource variables to the uids `dvn-prometheus` / `dvn-postgres`; if yours are
named differently, repoint the variable once at the top of the dashboard.

Alerts: `worker/deploy/k8s/prometheusrule.yaml`.
