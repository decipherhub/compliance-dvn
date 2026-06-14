# Security Policy

The Compliance DVN enforces an AML/sanctions boundary: as the single required DVN, a
withheld `verify` attestation vetoes a non-compliant transfer before it settles.
Anything that undermines that boundary is a security issue, and we treat it as one.

## What counts as a security issue

Please report privately if you find a way to:

- **Bypass or evade screening** — get a flagged sender/receiver/recipient past `assess()`
  / `combine()`.
- **Defeat the veto** — cause a packet to commit/deliver despite a withheld attestation,
  or force a verification the worker did not intend.
- **Forge or replay attestations**, or call `submitVerification` outside the operator gate.
- **Fail the system open** — make the worker verify a transfer it should have vetoed when
  a data source is empty, stale, or unreachable.
- **Corrupt or poison the denylist** sources or the merge step.
- **Leak operator secrets** (private keys, RPC credentials) from config or logs.

General defects that do not weaken enforcement should go through the normal
[bug report](https://github.com/decipherhub/compliance-dvn/issues/new/choose) flow instead.

## Reporting a vulnerability

**Do not open a public issue or pull request for a vulnerability.**

Report it privately through GitHub's coordinated disclosure:

- Open a [private security advisory](https://github.com/decipherhub/compliance-dvn/security/advisories/new), or
- Use the **Report a vulnerability** button on the repository's **Security** tab.

Please include:

1. A description of the issue and its impact (what enforcement boundary it breaks).
2. Steps to reproduce — addresses, chains, config, and tx hashes / LayerZero Scan links
   where applicable.
3. A proof of concept if you have one.
4. Any suggested remediation.

## Our commitment

- We will acknowledge your report within **3 business days**.
- We will provide an assessment and expected timeline within **10 business days**.
- We will keep you updated as we work on a fix and credit you on disclosure unless you
  prefer to remain anonymous.
- Please give us a reasonable window to remediate before any public disclosure.

## Scope

This project is research / reference software provided under the MIT License with no
warranty. The deployed testnet contracts listed in the README are for demonstration.
Findings against third-party dependencies (LayerZero protocol, OpenZeppelin, sanctions
data providers) should be reported to those projects, though we welcome a heads-up so we
can mitigate on our side.
