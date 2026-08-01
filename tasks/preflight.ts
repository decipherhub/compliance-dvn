import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { task } from 'hardhat/config'

import { OAPP_CONTRACT } from '../oapp.contract'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** 0x is optional — ethers and hardhat both accept a bare 64-hex key. */
const HEX_PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/** ReceiveUln302 per LayerZero eid — must match deploy/ComplianceDVN.ts. */
const RECEIVE_ULN: Record<number, string> = {
    40245: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d', // base-sepolia
    40232: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca', // optimism-sepolia
}

/** EndpointV2, identical on both testnets. */
const ENDPOINT_V2 = '0x6EDCE65403992e310A62460808c4b910D972f10f'

const DVN_ENV: Record<number, string> = {
    40245: 'DVN_BASE_SEPOLIA',
    40232: 'DVN_OPTIMISM_SEPOLIA',
}

/**
 * How many deploy-equivalents of balance to ask for. Deployment is one transaction; wiring adds
 * several config calls of comparable size, and gas can move between now and then.
 */
const DEPLOY_COST_HEADROOM = 25

/**
 * Price the actual deployment instead of guessing at it.
 *
 * Returns undefined when estimation is not possible (an unfunded account on a strict node, an
 * unknown chain), in which case the caller simply skips the adequacy check rather than inventing
 * a number — the separate zero-balance check still blocks the genuinely broken case.
 */
async function estimateDeployCost(
    hre: import('hardhat/types').HardhatRuntimeEnvironment,
    deployer: string,
    eid: number | undefined
): Promise<
    { gas: import('ethers').BigNumber; price: import('ethers').BigNumber; cost: import('ethers').BigNumber } | undefined
> {
    const receiveUln = eid ? RECEIVE_ULN[eid] : undefined
    if (!receiveUln) return undefined
    try {
        const factory = await hre.ethers.getContractFactory('ComplianceDVN')
        const tx = factory.getDeployTransaction(
            deployer,
            (process.env.OPERATOR_ADDRESS ?? '').trim() || deployer,
            receiveUln,
            hre.ethers.utils.parseEther('0.00005')
        )
        const [gas, price] = await Promise.all([
            hre.ethers.provider.estimateGas({ ...tx, from: deployer }),
            hre.ethers.provider.getGasPrice(),
        ])
        return { gas, price, cost: gas.mul(price) }
    } catch {
        return undefined
    }
}

/**
 * Check everything that has to be true before spending gas, and report every problem at once.
 *
 * Deployment failures are cheap to diagnose but expensive to half-complete: a deploy that lands
 * and then cannot be wired leaves an OApp pointing at nothing. This runs the same checks the
 * deploy and wire steps depend on, without sending a transaction.
 */
task('dvn:preflight', 'Validate deploy prerequisites on the current --network without sending transactions').setAction(
    async (_args, hre) => {
        const problems: string[] = []
        const warnings: string[] = []
        const eid = (hre.network.config as { eid?: number }).eid

        console.log(`network:  ${hre.network.name}${eid ? ` (eid ${eid})` : ''}`)

        // --- signer -------------------------------------------------------------------------
        //
        // Kept deliberately minimal: hardhat validates `accounts` while loading the config, so a
        // malformed key fails with its own clear message ("private key too short, expected 32
        // bytes") before this task ever runs. The only gap worth covering is an ABSENT key, which
        // hardhat tolerates at load time and then fails on much later and much less clearly.
        //
        // The 0x prefix is optional because ethers and hardhat both accept a bare 64-hex key.
        // Requiring it here would block a configuration that deploys perfectly well.
        const pk = (process.env.PRIVATE_KEY ?? '').trim()
        if (!pk) problems.push('PRIVATE_KEY is not set — hardhat has no account to deploy from')
        else if (!HEX_PRIVATE_KEY.test(pk)) {
            problems.push(
                `PRIVATE_KEY is not a 32-byte hex key (got ${pk.length} chars; expected 64 hex digits, with or without a 0x prefix)`
            )
        }

        let deployer: string | undefined
        if (!problems.length) {
            try {
                deployer = (await hre.getNamedAccounts()).deployer
            } catch (err) {
                problems.push(`cannot resolve the deployer account: ${(err as Error).message}`)
            }
        }

        // --- rpc + balance ------------------------------------------------------------------
        if (deployer) {
            console.log(`deployer: ${deployer}`)
            try {
                const balance = await hre.ethers.provider.getBalance(deployer)
                console.log(`balance:  ${hre.ethers.utils.formatEther(balance)} ETH`)
                if (balance.isZero()) {
                    problems.push(`deployer has no balance on ${hre.network.name} — fund it first`)
                } else {
                    // Compare against the MEASURED deploy cost rather than a fixed ETH figure. A
                    // hardcoded threshold calibrated for L1 is off by three orders of magnitude on
                    // an OP-stack L2, so it fires on every healthy balance — and a warning that
                    // always fires is one people learn to skip.
                    const estimate = await estimateDeployCost(hre, deployer, eid)
                    if (estimate) {
                        const { gas, price, cost } = estimate
                        console.log(
                            `deploy est: ${hre.ethers.utils.formatEther(cost)} ETH ` +
                                `(${gas.toString()} gas @ ${hre.ethers.utils.formatUnits(price, 'gwei')} gwei)`
                        )
                        // Deploy plus wiring is a handful of similar transactions; ask for real
                        // headroom on top so gas moving under us does not strand it half-done.
                        const needed = cost.mul(DEPLOY_COST_HEADROOM)
                        if (balance.lt(needed)) {
                            warnings.push(
                                `deployer balance ${hre.ethers.utils.formatEther(balance)} ETH is under ${DEPLOY_COST_HEADROOM}x the estimated deploy cost (${hre.ethers.utils.formatEther(needed)} ETH). Deploy plus wiring is several transactions — top it up rather than risk stopping midway.`
                            )
                        }
                    }
                }
            } catch (err) {
                problems.push(`RPC unreachable for ${hre.network.name}: ${(err as Error).message}`)
            }
        }

        // --- chain metadata -----------------------------------------------------------------
        if (!eid) problems.push(`network '${hre.network.name}' has no eid configured`)
        else if (!RECEIVE_ULN[eid]) problems.push(`no ReceiveUln302 known for eid ${eid}`)
        else console.log(`receiveUln: ${RECEIVE_ULN[eid]}`)

        // --- operator separation ------------------------------------------------------------
        const operator = (process.env.OPERATOR_ADDRESS ?? '').trim()
        if (operator && !EVM_ADDRESS.test(operator)) {
            problems.push('OPERATOR_ADDRESS is set but is not a 20-byte EVM address')
        } else if (!operator) {
            warnings.push(
                'OPERATOR_ADDRESS is unset, so owner and operator collapse onto the deployer. The worker would then be able to approve its own held packets — set it to the worker key to keep approval a human-only action.'
            )
        } else if (!deployer) {
            // Never claim the roles are separate without having compared them. The owner/operator
            // split is the reason approval is human-only; asserting it unverified is worse than
            // saying nothing, because it reads as a passed check.
            console.log(`operator: ${operator} (cannot compare to owner until PRIVATE_KEY is valid)`)
        } else if (operator.toLowerCase() === deployer.toLowerCase()) {
            warnings.push('OPERATOR_ADDRESS equals the deployer, so owner and operator are the same key')
        } else {
            console.log(`operator: ${operator} (distinct from owner — good)`)
        }

        // The operator's balance is not needed to deploy, but the worker cannot verify a single
        // packet without it — and that failure surfaces much later, as `submitVerification failed`,
        // long after deployment looked successful. Cheaper to say so now.
        if (operator && EVM_ADDRESS.test(operator)) {
            try {
                const balance = await hre.ethers.provider.getBalance(operator)
                console.log(`operator balance: ${hre.ethers.utils.formatEther(balance)} ETH`)
                if (balance.isZero()) {
                    warnings.push(
                        `operator ${operator} has no balance on ${hre.network.name}. It is not needed to deploy, but the worker signs submitVerification/commitVerification on the DESTINATION chain — so it needs funding on every chain before it can verify anything.`
                    )
                }
            } catch {
                // The deployer balance check above already reports an unreachable RPC.
            }
        }

        // --- already deployed? --------------------------------------------------------------
        try {
            const existing = await hre.deployments.getOrNull('ComplianceDVN')
            if (existing) {
                console.log(`existing deployment: ${existing.address}`)
                const dvn = await hre.ethers.getContractAt('ComplianceDVN', existing.address)
                // A deployment that predates the RiskVerdict work has no ACTION_BLOCK constant, so
                // the worker's ABI would not match it.
                try {
                    await dvn.ACTION_BLOCK()
                    console.log('  exposes ACTION_BLOCK — verdict-event ABI present')
                } catch {
                    warnings.push(
                        `the existing deployment at ${existing.address} predates the RiskVerdict interface; redeploy and re-wire, then update DVN_* in .env`
                    )
                }
                // A deployment that predates the assignJob gate accepts jobs from anyone, which
                // lets a stranger point the worker at packets no one asked it to verify.
                try {
                    await dvn.sendUln()
                    console.log('  exposes sendUln — assignJob is gated to the send library')
                } catch {
                    warnings.push(
                        `the existing deployment at ${existing.address} predates the assignJob send-library gate; redeploy and re-wire, then update DVN_* in .env`
                    )
                }
            } else {
                console.log('existing deployment: none (this will be a fresh deploy)')
            }
        } catch (err) {
            warnings.push(`could not inspect existing deployments: ${(err as Error).message}`)
        }

        // --- wiring authority ---------------------------------------------------------------
        //
        // Wiring calls `EndpointV2.setConfig(oapp, lib, params)`, which only the OApp or its
        // registered delegate may do. Getting this wrong does not fail at config time — it fails
        // as `LZ_Unauthorized()` mid-wire, after the deploy has already landed. Read it up front.
        if (deployer) {
            const record = path.join(__dirname, '..', 'deployments', hre.network.name, `${OAPP_CONTRACT}.json`)
            if (!existsSync(record)) {
                warnings.push(
                    `no ${OAPP_CONTRACT} deployment for ${hre.network.name} — deploy it before wiring (the OApp must exist to be configured)`
                )
            } else {
                const oapp = (JSON.parse(readFileSync(record, 'utf8')) as { address: string }).address
                try {
                    const endpoint = new hre.ethers.Contract(
                        ENDPOINT_V2,
                        ['function delegates(address) view returns (address)'],
                        hre.ethers.provider
                    )
                    const delegate: string = await endpoint.delegates(oapp)
                    const authorized = delegate.toLowerCase() === deployer.toLowerCase()
                    console.log(`oapp:     ${OAPP_CONTRACT} ${oapp}`)
                    console.log(`  delegate ${delegate} ${authorized ? 'is us — can wire' : 'is NOT us'}`)
                    if (!authorized) {
                        problems.push(
                            `${OAPP_CONTRACT} at ${oapp} has delegate ${delegate}, not the deployer ${deployer}. Wiring would revert with LZ_Unauthorized(). Either wire with that key, have it call setDelegate(${deployer}), or point OAPP_CONTRACT at an OApp this key owns.`
                        )
                    }
                } catch (err) {
                    warnings.push(`could not read the OApp delegate: ${(err as Error).message}`)
                }
            }
        }

        // --- wiring prerequisite ------------------------------------------------------------
        if (eid && DVN_ENV[eid]) {
            const configured = (process.env[DVN_ENV[eid]] ?? '').trim()
            if (!EVM_ADDRESS.test(configured)) {
                console.log(`${DVN_ENV[eid]}: not set (expected — set it after deploying, before wiring)`)
            } else {
                console.log(`${DVN_ENV[eid]}: ${configured}`)
            }
        }

        // --- report -------------------------------------------------------------------------
        console.log('')
        for (const w of warnings) console.log(`WARN  ${w}`)
        for (const p of problems) console.log(`ERROR ${p}`)
        if (problems.length) {
            // Exit rather than throw: a failed preflight is an expected outcome, and a stack trace
            // buries the list of problems the operator actually needs to read.
            console.log(`\n${problems.length} blocking problem(s) — resolve them before deploying`)
            process.exit(1)
        }
        console.log(warnings.length ? `preflight passed with ${warnings.length} warning(s)` : 'preflight passed')
    }
)
