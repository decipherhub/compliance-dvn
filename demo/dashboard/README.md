# Demo dashboard

Four static pages over the read-only APIs of the worker and indexer. No build step, no framework,
no server-side state — every write is signed in MetaMask, so this page never holds a key.

```bash
cd dashboard && python serve.py
```

Then open <http://localhost:8080>. Use [`serve.py`](serve.py) rather than `python -m http.server`:
the latter answers conditional requests with 304, so an edited page keeps serving the old bytes
until a hard reload — which during a demo reads as "the change did not work".

## Wallets

Connecting enumerates every injected provider (EIP-6963, plus the legacy `window.ethereum`
array) and prefers MetaMask, then tries the rest in turn. A multi-chain wallet that claims
`window.ethereum` without holding an Ethereum account rejects `eth_requestAccounts` with
*"Unable to find any account for 60"* — 60 being Ethereum's BIP-44 coin type — so taking
`window.ethereum` on faith dead-ends the page even when MetaMask is installed alongside. The
connected wallet's name is shown next to the address.

The interface is in Korean. On-chain vocabulary (`sanctions_1hop`, `block`, …) is shown in Korean
but keeps its identifier on the element's `title`, because that string is what appears in the event
log, the policy source, and the CLI — an auditor comparing this screen against a transaction needs
it within reach. Panel rationale sits behind a `?` marker rather than in the layout.

| Page | What it does |
| --- | --- |
| `index.html` (전송) | Cross-chain OFT send (MetaMask), testUSDT faucet, same-chain transfer, and **내 패킷** — the tracker that makes a withheld packet visible |
| `holds.html` (보류 패킷) | The worker's held-packet queue, with owner-signed `approvePacket`, plus the on-chain approval trail |
| `overview.html` (종합 현황) | Verdict log with decoded reason masks, sanctions seed list, watched config, the served feed, live proximity labels, recent edges |
| `graph.html` (그래프) | Force-directed transfer graph coloured by distance to a sanctioned seed, with per-address inspection |

## Font

Pretendard Variable is self-hosted in [`fonts/`](fonts/) — one face covering Hangul and Latin, so
mixed strings like `피드 v120` no longer fall back per-glyph into two mismatched weights. Licensed
under SIL OFL 1.1; the licence ships alongside it in `fonts/LICENSE-Pretendard.txt`, as the licence
requires. Addresses and hashes keep the system monospace stack, since hex needs fixed advance.

## Configuration

Edit [`config.js`](config.js) — chain metadata, contract addresses, API origins, and the friendly
names shown instead of raw hex. It is a plain file on purpose: it holds no secrets, and a wrong
value should be visible at a glance rather than buried in a bundle.

After redeploying contracts, update `token` and `dvn` per chain there, exactly as you would in the
three `.env` files.

## What it reads

- **indexer** `:9091` — `/api/status`, `/api/seeds`, `/api/verdicts`, `/api/approvals`, `/api/edges`,
  `/api/proximity`, `/feed/latest.json`
- **worker** `:9090` — `/status`, `/pending`

Both send `access-control-allow-origin: *`; everything they expose is already public (on-chain
events, published sanctions lists, a signed feed). Neither exposes a write endpoint: releasing a
held packet is an on-chain owner action, never an HTTP call.

If the worker is not running, the pages say so rather than showing an empty queue — "no holds" and
"cannot tell" must not look the same.
