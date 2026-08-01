-- Compliance DVN indexer — initial schema.
--
-- Numeric columns use numeric(78,0) because token values are uint256, which does not fit a
-- bigint. Addresses and hashes are stored lowercased hex; every write goes through a helper
-- that normalizes, so queries never need to case-fold.

-- Per-chain scan cursor. Advances only after a range is fully committed.
CREATE TABLE IF NOT EXISTS scan_cursor (
  chain      text   PRIMARY KEY,
  last_block bigint NOT NULL
);

-- Block identity, kept so a reorg can be detected by comparing parent hashes rather than
-- guessing from block numbers alone.
--
-- `block_time` is the only wall-clock anchor in the schema: events carry a block number, not a
-- timestamp, so anything that plots the audit trail over time joins through here.
CREATE TABLE IF NOT EXISTS blocks (
  chain       text   NOT NULL,
  number      bigint NOT NULL,
  hash        text   NOT NULL,
  parent_hash text   NOT NULL,
  block_time  bigint NOT NULL,
  PRIMARY KEY (chain, number)
);

-- ERC-20 transfer edges. The (chain, tx_hash, log_index) primary key IS the dedup: re-scanning
-- a range is idempotent.
CREATE TABLE IF NOT EXISTS edges (
  chain        text          NOT NULL,
  block_number bigint        NOT NULL,
  tx_hash      text          NOT NULL,
  log_index    integer       NOT NULL,
  token        text          NOT NULL,
  from_addr    text          NOT NULL,
  to_addr      text          NOT NULL,
  value        numeric(78,0) NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS edges_from_idx  ON edges (from_addr);
CREATE INDEX IF NOT EXISTS edges_to_idx    ON edges (to_addr);
CREATE INDEX IF NOT EXISTS edges_block_idx ON edges (chain, block_number);

-- Authoritative labels the graph is seeded from (sanctioned addresses, sanctioned mixers).
CREATE TABLE IF NOT EXISTS seed_labels (
  subject text NOT NULL,
  label   text NOT NULL,
  source  text NOT NULL,
  PRIMARY KEY (subject, label, source)
);

-- Verdicts emitted by our own DVN. Collected for audit and dashboards. Deliberately NOT fed
-- back into published labels by default — see src/feed/builder.ts on self-amplification.
CREATE TABLE IF NOT EXISTS risk_verdicts (
  chain         text          NOT NULL,
  block_number  bigint        NOT NULL,
  tx_hash       text          NOT NULL,
  log_index     integer       NOT NULL,
  payload_hash  text          NOT NULL,
  action        smallint      NOT NULL,
  score         integer       NOT NULL,
  reason_mask   numeric(78,0) NOT NULL,
  evidence_hash text          NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS risk_verdicts_payload_idx ON risk_verdicts (payload_hash);
CREATE INDEX IF NOT EXISTS risk_verdicts_block_idx   ON risk_verdicts (chain, block_number);

-- Owner approvals of held packets.
CREATE TABLE IF NOT EXISTS packet_approvals (
  chain        text    NOT NULL,
  block_number bigint  NOT NULL,
  tx_hash      text    NOT NULL,
  log_index    integer NOT NULL,
  payload_hash text    NOT NULL,
  approver     text    NOT NULL,
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS packet_approvals_block_idx ON packet_approvals (chain, block_number);

-- Minimum transfer value, per token, for an INBOUND edge to count as exposure. This is the
-- dusting defence: anyone can push a tainted transfer at a victim, so an inbound edge below the
-- minimum is recorded but never labelled. A token with no row here is never labelled inbound.
CREATE TABLE IF NOT EXISTS token_minimums (
  chain     text          NOT NULL,
  token     text          NOT NULL,
  min_value numeric(78,0) NOT NULL,
  PRIMARY KEY (chain, token)
);

-- Every feed document published, so a consumer can be handed an older version and the
-- monotonic version counter survives a restart.
CREATE TABLE IF NOT EXISTS feeds (
  version        bigint  PRIMARY KEY,
  generated_at   bigint  NOT NULL,
  expires_at     bigint  NOT NULL,
  policy_version integer NOT NULL,
  entry_count    integer NOT NULL,
  document       text    NOT NULL
);
