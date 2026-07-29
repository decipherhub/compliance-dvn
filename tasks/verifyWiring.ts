import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { task } from 'hardhat/config'

import { OAPP_CONTRACT } from '../oapp.contract'

const ENDPOINT_V2 = '0x6EDCE65403992e310A62460808c4b910D972f10f'
const ULN_CONFIG_TYPE = 2

/** Send and receive libraries per eid, matching the LayerZero deployment. */
const LIBS: Record<number, { sendUln: string; receiveUln: string; peerEid: number }> = {
    40245: {
        sendUln: '0xC1868e054425D378095A003EcbA3823a5D0135C9',
        receiveUln: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d',
        peerEid: 40232,
    },
    40232: {
        sendUln: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f',
        receiveUln: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca',
        peerEid: 40245,
    },
}

const ENDPOINT_ABI = [
    'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes)',
]

const ULN_CONFIG_TUPLE =
    'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)'

/**
 * Confirm the DVN is actually REQUIRED by the wired pathway, by decoding the on-chain ULN config.
 *
 * `lz:oapp:wire --dry-run` reporting "no action necessary" says the chain matches the config file;
 * it does not say the config file expresses what we think. This reads the ULN config back and
 * asserts our DVN is in `requiredDVNs` — which is the single fact the whole veto mechanism rests
 * on. If the DVN were merely optional, or absent, withholding verification would block nothing.
 */
task('dvn:verify-wiring', 'Decode the on-chain ULN config and assert our DVN is required').setAction(
    async (_args, hre) => {
        const eid = (hre.network.config as { eid?: number }).eid
        if (!eid || !LIBS[eid]) throw new Error(`no library set known for eid ${eid}`)
        const { sendUln, receiveUln, peerEid } = LIBS[eid]

        const record = path.join(__dirname, '..', 'deployments', hre.network.name, `${OAPP_CONTRACT}.json`)
        if (!existsSync(record)) throw new Error(`no ${OAPP_CONTRACT} deployment for ${hre.network.name}`)
        const oapp = (JSON.parse(readFileSync(record, 'utf8')) as { address: string }).address

        const dvnRecord = path.join(__dirname, '..', 'deployments', hre.network.name, 'ComplianceDVN.json')
        if (!existsSync(dvnRecord)) throw new Error(`no ComplianceDVN deployment for ${hre.network.name}`)
        const dvn = (JSON.parse(readFileSync(dvnRecord, 'utf8')) as { address: string }).address.toLowerCase()

        const endpoint = new hre.ethers.Contract(ENDPOINT_V2, ENDPOINT_ABI, hre.ethers.provider)
        const fails: string[] = []

        console.log(`network: ${hre.network.name} (eid ${eid})`)
        console.log(`oapp:    ${OAPP_CONTRACT} ${oapp}`)
        console.log(`dvn:     ${dvn}`)

        // Both directions are configured on THIS chain: the send config governs outbound messages,
        // the receive config governs what this chain demands of inbound ones. A DVN missing from
        // either leaves that direction unscreened.
        for (const [label, lib] of [
            ['send   ', sendUln],
            ['receive', receiveUln],
        ] as const) {
            const raw = await endpoint.getConfig(oapp, lib, peerEid, ULN_CONFIG_TYPE)
            const [cfg] = hre.ethers.utils.defaultAbiCoder.decode([ULN_CONFIG_TUPLE], raw)
            const required = (cfg.requiredDVNs as string[]).map((a) => a.toLowerCase())
            const has = required.includes(dvn)
            console.log(
                `  ${label}: confirmations=${cfg.confirmations} requiredDVNCount=${cfg.requiredDVNCount} ` +
                    `optional=${cfg.optionalDVNCount}/${cfg.optionalDVNThreshold}`
            )
            console.log(
                `           requiredDVNs=${JSON.stringify(required)} ${has ? 'contains our DVN' : 'MISSING our DVN'}`
            )

            if (!has)
                fails.push(
                    `${label.trim()} config does not require our DVN — withholding verification would block nothing`
                )
            if (Number(cfg.requiredDVNCount) === 0) fails.push(`${label.trim()} config requires zero DVNs`)
            // An optional-DVN threshold of 0 alongside optional DVNs would let a message settle
            // without any of them; not our configuration, but worth catching if it ever becomes so.
            if (Number(cfg.optionalDVNCount) > 0 && Number(cfg.optionalDVNThreshold) === 0) {
                fails.push(`${label.trim()} config has optional DVNs with a zero threshold`)
            }
        }

        console.log('')
        if (fails.length) {
            for (const f of fails) console.log(`FAIL  ${f}`)
            process.exit(1)
        }
        console.log('our DVN is required in both directions — the veto path is armed')
    }
)
