import { ethers } from 'ethers'
import type { ChainReader } from '../assess/providers/contract'

/**
 * Adapt an ethers provider to the narrow `ChainReader` the contract risk provider needs.
 *
 * The provider module stays ethers-free so it can be unit-tested with plain stubs; this is the
 * one place the two meet.
 */
export function ethersReader(provider: ethers.providers.Provider): ChainReader {
  return {
    getCode: (address) => provider.getCode(address),
    getStorageAt: (address, slot) => provider.getStorageAt(address, slot),
    call: (tx) => provider.call(tx),
  }
}
