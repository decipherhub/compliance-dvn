import { EndpointId } from '@layerzerolabs/lz-definitions'

const DVN_BASE = process.env.DVN_BASE_SEPOLIA || '0x0000000000000000000000000000000000000000'
const DVN_OPT = process.env.DVN_OPTIMISM_SEPOLIA || '0x0000000000000000000000000000000000000000'

const base = { eid: EndpointId.BASESEP_V2_TESTNET, contractName: 'ToyOFT' }
const opt = { eid: EndpointId.OPTSEP_V2_TESTNET, contractName: 'ToyOFT' }

// One ULN config per chain, referencing THAT chain's ComplianceDVN as the single required DVN.
const ulnBase = {
    confirmations: BigInt(5),
    requiredDVNs: [DVN_BASE],
    optionalDVNs: [] as string[],
    optionalDVNThreshold: 0,
}
const ulnOpt = {
    confirmations: BigInt(5),
    requiredDVNs: [DVN_OPT],
    optionalDVNs: [] as string[],
    optionalDVNThreshold: 0,
}

const execBase = { maxMessageSize: 10000, executor: '0x8A3D588D9f6AC041476b094f97FF94ec30169d3D' }
const execOpt = { maxMessageSize: 10000, executor: '0xDc0D68899405673b932F0DB7f8A49191491A5bcB' }

export default {
    contracts: [{ contract: base }, { contract: opt }],
    connections: [
        // A connection `from: A, to: B` configures the OApp ON chain A. BOTH its sendConfig
        // (A->B send) and its receiveConfig (A receiving from B) are applied on A, so BOTH
        // must reference chain A's own ComplianceDVN. (A DVN address only has code on its own
        // chain: getFee/assignJob run on the sender, verify runs on the receiver, and for the
        // OApp on A all of those happen on A.)
        {
            from: base,
            to: opt,
            config: {
                sendConfig: { executorConfig: execBase, ulnConfig: ulnBase },
                receiveConfig: { ulnConfig: ulnBase },
            },
        },
        {
            from: opt,
            to: base,
            config: {
                sendConfig: { executorConfig: execOpt, ulnConfig: ulnOpt },
                receiveConfig: { ulnConfig: ulnOpt },
            },
        },
    ],
}
