import { EndpointId } from '@layerzerolabs/lz-definitions'

const DVN_BASE = process.env.DVN_BASE_SEPOLIA || '0x0000000000000000000000000000000000000000'
const DVN_OPT = process.env.DVN_OPTIMISM_SEPOLIA || '0x0000000000000000000000000000000000000000'

const base = { eid: EndpointId.BASESEP_V2_TESTNET, contractName: 'ToyOFT' }
const opt = { eid: EndpointId.OPTSEP_V2_TESTNET, contractName: 'ToyOFT' }

// One ULN config per chain, referencing THAT chain's ComplianceDVN as the single required DVN.
const ulnBase = { confirmations: BigInt(5), requiredDVNs: [DVN_BASE], optionalDVNs: [] as string[], optionalDVNThreshold: 0 }
const ulnOpt = { confirmations: BigInt(5), requiredDVNs: [DVN_OPT], optionalDVNs: [] as string[], optionalDVNThreshold: 0 }

const execBase = { maxMessageSize: 10000, executor: '0x8A3D588D9f6AC041476b094f97FF94ec30169d3D' }
const execOpt = { maxMessageSize: 10000, executor: '0xDc0D68899405673b932F0DB7f8A49191491A5bcB' }

export default {
    contracts: [{ contract: base }, { contract: opt }],
    connections: [
        {
            from: base,
            to: opt,
            // send & receive ulnConfig for a pathway both reference the DESTINATION chain's DVN,
            // since that's the address that signs verification on the receive side.
            // Pathway base->opt is verified on opt's ReceiveUln, which enforces opt's requiredDVNs (DVN_OPT).
            // The send side on base must declare the SAME DVN set the destination expects, so both use ulnOpt.
            config: {
                sendConfig: { executorConfig: execBase, ulnConfig: ulnOpt },
                receiveConfig: { ulnConfig: ulnOpt },
            },
        },
        {
            from: opt,
            to: base,
            // Pathway opt->base is verified on base's ReceiveUln (DVN_BASE); both send & receive use ulnBase.
            config: {
                sendConfig: { executorConfig: execOpt, ulnConfig: ulnBase },
                receiveConfig: { ulnConfig: ulnBase },
            },
        },
    ],
}
