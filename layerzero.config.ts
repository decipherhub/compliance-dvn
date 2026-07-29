import { EndpointId } from '@layerzerolabs/lz-definitions'

import { OAPP_CONTRACT } from './oapp.contract'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Read a deployed ComplianceDVN address, refusing to fall back to a placeholder.
 *
 * Wiring is the step that tells the ULN which DVN a pathway REQUIRES. A zero or malformed address
 * here does not fail loudly at wire time — it succeeds, and every subsequent message on that
 * pathway becomes permanently unverifiable because the required DVN has no code to verify with.
 * Failing here costs one clear error; not failing costs a re-wire and stuck packets.
 */
function requireDvn(envVar: string): string {
    const value = (process.env[envVar] ?? '').trim()
    if (!EVM_ADDRESS.test(value)) {
        throw new Error(
            `${envVar} must be the deployed ComplianceDVN address (0x + 40 hex) before wiring. ` +
                `Deploy first, then set it in .env — wiring with a placeholder would require a DVN that cannot verify.`
        )
    }
    return value
}

const DVN_BASE = requireDvn('DVN_BASE_SEPOLIA')
const DVN_OPT = requireDvn('DVN_OPTIMISM_SEPOLIA')

const base = { eid: EndpointId.BASESEP_V2_TESTNET, contractName: OAPP_CONTRACT }
const opt = { eid: EndpointId.OPTSEP_V2_TESTNET, contractName: OAPP_CONTRACT }

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
