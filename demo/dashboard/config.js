/**
 * Demo dashboard configuration.
 *
 * Deliberately a plain file the operator edits by hand: this page is served statically, holds no
 * secrets, and every write it performs is signed in MetaMask. Nothing here is a credential —
 * addresses and RPC URLs only. If a value is wrong the page says so rather than guessing.
 */
window.DVN_CONFIG = {
  // Read-only APIs. The worker one is optional: without it the Held Packets page explains that
  // the worker is not reachable instead of showing an empty queue, which would look like "no holds".
  indexerApi: 'http://localhost:9091',
  workerApi: 'http://localhost:9090',

  chains: {
    baseSepolia: {
      label: 'Base Sepolia',
      eid: 40245,
      chainId: 84532,
      chainIdHex: '0x14a34',
      rpc: 'https://sepolia.base.org',
      explorer: 'https://sepolia.basescan.org',
      dvn: '0x497E0962BeD72DC12Fb249995cA618a929C0d17A',
      nativeLabel: 'ETH',
      // Same address on both chains; needed to read channel nonces and to skip a stalled one.
      endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    },
    optimismSepolia: {
      label: 'OP Sepolia',
      eid: 40232,
      chainId: 11155420,
      chainIdHex: '0xaa37dc',
      rpc: 'https://sepolia.optimism.io',
      explorer: 'https://sepolia-optimism.etherscan.io',
      dvn: '0x7843CAf643A175fc3d0E4746678BEdAAFc396e65',
      nativeLabel: 'ETH',
      endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    },
  },

  /**
   * Sendable tokens, each wired to the DVN on both chains.
   *
   * The impersonation check runs on the token being MOVED — the engine resolves a packet's OApp
   * through `token()` and compares it against the chain's canonical issuer. So demonstrating it
   * means sending the decoy, not sending to it.
   */
  tokens: {
    // On-chain symbol is `testUSDT`; the label is the Korean reading of the same thing.
    testUSDT: {
      label: '테스트 USDT',
      addresses: {
        baseSepolia: '0x2DC5e5177a172c0FDc7c7d490A5D6D098e822eB7',
        optimismSepolia: '0x5237Ca5731f00741E10E5dB0cedA0796e21f08a6',
      },
    },
    // Claims the USDC symbol from an address that is not Circle's — which is what
    // `fake_stablecoin_suspect` looks for.
    fakeUSDC: {
      label: '가짜 USDC (미끼)',
      addresses: {
        baseSepolia: '0xcE65144C75d77c479b7FF12Cff41a1AC5359A578',
        optimismSepolia: '0xf970027c806420a0222F5b72b097d3fDeC81b228',
      },
    },
  },

  /** Named addresses, shown as chips instead of raw hex wherever they appear. */
  labels: {
    '0x8583894d0e57e42abb83039537f314490038efa0': 'owner (O)',
    '0x01d24ae2cd8ad18472bd00afe4ec425e800e184d': 'worker (W)',
    '0xcd346e8762e27d0558a260c1c3562127c52ad45b': 'feed (F)',
    '0x25d10657a2642fe8cd6bee501dbd0939d79bd90f': '정상 지갑 (A)',
    '0x9a1c282eba5e9a97290cac530902fb00dcf2ece2': '1홉 지갑 (B)',
    '0x000000000000000000000000000000000000dead': '차단 목록 (S)',
    '0x0330070fd38ec3bb94f58fa55d40368271e9e54a': 'OFAC 시드 (X)',
    '0xce65144c75d77c479b7ff12cff41a1ac5359a578': '가짜 USDC OFT (Base)',
    '0xf970027c806420a0222f5b72b097d3fdec81b228': '가짜 USDC OFT (OP)',
    '0x9771013d82dcc2bdb489b982b4f201fd698a15e6': '위험 프록시 (OP)',
    '0xebb646c8ed3a06d37bd779c994a9d479abc788d3': '위험 프록시 (Base)',
  },

  /**
   * Contract whose EIP-1967 admin is a flagged address, per chain.
   *
   * Screened as the OFT RECIPIENT — the only demo where what matters is a property of the contract
   * receiving the funds rather than the sender's history or the token's identity.
   */
  riskyProxy: {
    baseSepolia: '0xeBb646C8eD3A06d37bd779C994A9d479abC788d3',
    optimismSepolia: '0x9771013D82dcC2bdb489B982B4f201FD698A15e6',
  },
}
