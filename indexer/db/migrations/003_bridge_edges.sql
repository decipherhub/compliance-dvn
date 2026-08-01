-- Cross-chain sends as first-class edges.
--
-- An OFT send is a burn on the source and a mint on the destination, and the zero address is
-- excluded from every path (see graph/proximity.ts), so a bridged transfer previously left no
-- traversable edge at all. Worse, a send the DVN blocks never reaches the destination — our own
-- enforcement erased the evidence that would justify the next decision.
--
-- The source chain's `OFTSent` (who sent, how much) joined to the endpoint's `PacketSent` (who it
-- was addressed to) reconstructs the true counterparty pair, whether or not the packet was
-- delivered. Those land here as ordinary edges, marked so an attempt is never mistaken for a
-- settled transfer.
ALTER TABLE edges ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'transfer';

-- Where the value was addressed, for a bridge edge whose `to_addr` lives on another chain. NULL
-- for a same-chain transfer.
ALTER TABLE edges ADD COLUMN IF NOT EXISTS dst_chain text;
