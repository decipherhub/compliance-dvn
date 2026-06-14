<!--
Thanks for contributing to the Compliance DVN!
Keep PRs focused — one logical change per PR is far easier to review and revert.
-->

## Summary

<!-- What does this PR do, and why? Link the motivating issue. -->

Closes #

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation only
- [ ] Build / CI / tooling

## Area

- [ ] Contracts (`contracts/`)
- [ ] Worker — service / assess / tracker (`worker/`)
- [ ] CLI
- [ ] Deploy / wiring (`deploy/`, `tasks/`, `layerzero.config.ts`)
- [ ] Docs / tooling

## Security / compliance impact

<!-- If this touches screening, veto behavior, DVN config, secrets, logs, or external data sources, explain the impact and why enforcement still fails closed. Write "None" if not applicable. -->

## How was this tested?

<!-- Commands you ran and what you observed. Include tx hashes / LayerZero Scan links for on-chain changes. -->

- [ ] `forge test`
- [ ] `pnpm test:worker`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck:worker`
- [ ] Manual / on-chain verification (describe below)

```
<test output>
```

## Checklist

- [ ] My code follows the style of this project (`pnpm lint:fix` is clean).
- [ ] I added or updated tests that prove my change works.
- [ ] I updated documentation (README / guides) where behavior changed.
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] I reviewed the security / compliance impact above.
- [ ] This change does **not** weaken compliance enforcement (screening, veto, denylist coverage). If it touches that path, I explained why above.

## Notes for reviewers

<!-- Anything reviewers should pay special attention to: trade-offs, follow-ups, known limitations. -->
