export interface ChainCfg {
  name: string
  eid: number
  chainId: number
  rpc: string
  endpoint: string
  sendUln: string
  receiveUln: string
}

export const CHAINS: Record<string, ChainCfg> = {
  baseSepolia: {
    name: 'base-sepolia', eid: 40245, chainId: 84532,
    rpc: process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org',
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xC1868e054425D378095A003EcbA3823a5D0135C9',
    receiveUln: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d',
  },
  optimismSepolia: {
    name: 'optimism-sepolia', eid: 40232, chainId: 11155420,
    rpc: process.env.RPC_URL_OPTIMISM_SEPOLIA || 'https://sepolia.optimism.io',
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f',
    receiveUln: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca',
  },
}

// Populated after deploy (Phase 8): ComplianceDVN address per chain.
export const COMPLIANCE_DVN: Record<string, string> = {
  baseSepolia: process.env.DVN_BASE_SEPOLIA || '',
  optimismSepolia: process.env.DVN_OPTIMISM_SEPOLIA || '',
}
