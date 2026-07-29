-- Source-verification status per address.
--
-- Verification status cannot be read from chain state, so it comes from an external verifier
-- (Sourcify by default). Cached here because the answer is near-static and the verifier should
-- not be queried once per feed build.
--
-- `verified` is deliberately nullable and means three things, not two:
--   true  — the verifier positively reported a source match
--   false — the verifier answered, and this address was not among the matches
--   NULL  — we have not got an answer yet (never asked, or the request failed)
-- Only `false` produces an `unverified_contract` label. Treating NULL as unverified would let a
-- verifier outage label every contract in the graph.
CREATE TABLE IF NOT EXISTS contract_status (
  chain       text    NOT NULL,
  address     text    NOT NULL,
  is_contract boolean NOT NULL,
  verified    boolean,
  checked_at  bigint  NOT NULL,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS contract_status_pending_idx ON contract_status (chain, checked_at);
