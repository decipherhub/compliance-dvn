# Contributing to Compliance DVN

Thanks for your interest in contributing! This project is a LayerZero V2 Decentralized
Verifier Network (DVN) that screens OFT transfers for AML/sanctions hits and vetoes
non-compliant ones during message verification. Because it enforces a compliance
boundary, correctness and review discipline matter more here than in a typical example
repo — please read this guide before opening a pull request.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Reporting bugs, docs issues, and feature requests](#reporting-bugs-docs-issues-and-feature-requests)
- [Security issues](#security-issues)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Making a change](#making-a-change)
- [Coding standards](#coding-standards)
- [Tests](#tests)
- [Commit messages](#commit-messages)
- [Opening a pull request](#opening-a-pull-request)
- [License](#license)

## Ways to contribute

- **Report bugs**, **suggest features**, or **flag documentation issues** via the [issue templates](https://github.com/decipherhub/compliance-dvn/issues/new/choose).
- **Improve documentation** — README, the [custom workers guide](./CUSTOM_WORKERS_GUIDE.md), or inline comments.
- **Add or extend screening sources** in `worker/assess/` (new sanctions lists, registries, heuristics).
- **Harden the contracts or worker** with additional tests and edge cases.

If you plan to work on something substantial, please open an issue first so we can
align on the approach before you invest time.

## Reporting bugs, docs issues, and feature requests

Use the issue chooser — it routes you to the right template:

- **Bug report** — a defect in the contracts, worker, CLI, or tooling.
- **Feature suggestion** — a new capability or improvement.
- **Documentation improvement** — missing, unclear, stale, or incorrect docs.

Blank issues are disabled on purpose. Questions and open-ended discussion belong in
[Discussions](https://github.com/decipherhub/compliance-dvn/discussions).

## Security issues

**Do not open a public issue for security vulnerabilities** — especially anything that
lets a transfer evade screening or bypass the veto. Follow our
[Security Policy](./SECURITY.md) for private disclosure.

## Development setup

Requirements: **Node `>=18.16.0`** (this repo pins `v18.18.0` via `.nvmrc`),
[pnpm](https://pnpm.io/), and [Foundry](https://book.getfoundry.sh/) (`forge`).
The standalone `worker/package.json` declares Node `>=20`; use that when developing
from inside `worker/` directly.

```bash
nvm use                  # picks up .nvmrc
pnpm install
cp .env.example .env      # set PRIVATE_KEY; RPCs and TEST_DENYLIST are optional
pnpm compile              # forge build + hardhat compile
pnpm test                 # forge + hardhat
pnpm test:worker          # vitest
pnpm typecheck:worker     # worker TypeScript typecheck
```

You do **not** need funded testnet keys to develop and run the test suites. You only
need them for live deploy/wire/demo flows (see the README).

## Project layout

| Path                  | What lives here                                                                   |
| --------------------- | --------------------------------------------------------------------------------- |
| `contracts/`          | `ComplianceDVN.sol` (the thin on-chain DVN) and friends                           |
| `worker/service.ts`   | Always-on worker: watches `JobAssigned`, verifies/commits or vetoes               |
| `worker/assess/`      | Chain-independent risk engine — `assess()` / `combine()` over the merged denylist |
| `demo/`               | Demo assets: dashboard, decoy contracts, mint script (see `demo/README.md`)       |
| `deploy/`, `tasks/`   | Hardhat deploy scripts and operator tasks                                         |
| `test/`               | Foundry (`*.t.sol`) and Hardhat/Vitest tests                                      |
| `layerzero.config.ts` | DVN wiring (required DVN, per-chain ULN config)                                   |

## Making a change

1. Fork the repo and create a topic branch from `main`
   (`git checkout -b fix/assess-empty-denylist`).
2. Make your change, keeping it focused — one logical change per PR.
3. Add or update tests that prove the change.
4. Run the full local gate before pushing:

   ```bash
   pnpm lint
   pnpm typecheck:worker
   pnpm test
   pnpm test:worker
   ```

5. Open a pull request against `main` and fill out the template.

## Coding standards

- **Solidity** is linted with `solhint` (`@layerzerolabs/solhint-config`). Keep the
  on-chain contract thin — judgment belongs off-chain in the worker.
- **TypeScript / JS / JSON** is linted with ESLint (`@layerzerolabs/eslint-config-next`)
  and formatted with Prettier.
- Auto-fix everything before committing:

  ```bash
  pnpm lint:fix
  ```

- Don't disable lint rules to make CI pass without explaining why in the PR.
- Validate external/untrusted input (we use [zod](https://zod.dev/) in the worker).

## Tests

A change is not done until it's tested.

- **Contracts** — Foundry unit tests plus the `TestHelperOz5` integration that proves
  the veto end-to-end (clean packet delivers; withheld attestation reverts
  `commitVerification` with `LZ_ULN_Verifying`). Run with `forge test`.
- **Worker** — Vitest covers `assess()`/`combine()`, the header/OFT-message decoders,
  the `JobAssigned` filter, the durable checkpoint, and the tracker transform.
  Run with `pnpm test:worker` and `pnpm typecheck:worker`.
- New screening logic must include cases for **both** a flagged and a clean party, and
  for an **empty/unavailable** data source (fail closed, never silently allow).

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). Examples from this
repo's history:

```
feat(worker): production-grade CLI + service for the Compliance DVN
docs: add assess() extension guide
chore: gitignore presentation/
```

Common prefixes: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`.

## Opening a pull request

- Target the `main` branch.
- Fill out the PR template completely, including how you tested.
- Link the issue your PR closes (`Closes #123`).
- Keep the diff scoped; split unrelated changes into separate PRs.
- CI and at least one maintainer review must pass before merge.
- Be responsive to review feedback — we aim to review promptly in return.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
