import { existsSync, readFileSync } from 'fs'
import path from 'path'

import { task } from 'hardhat/config'

import { OAPP_CONTRACT } from '../oapp.contract'

const CLEAN_RECIPIENT = '0x000000000000000000000000000000000000cCCc'
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

task('demo:clean', `Send ${OAPP_CONTRACT} to a CLEAN (non-flagged) recipient — expect DELIVERED`)
    .addOptionalParam('to', 'clean recipient address', CLEAN_RECIPIENT)
    .addOptionalParam('dst', 'destination: base|opt', 'base')
    .addOptionalParam('amount', 'human amount', '1')
    .setAction(async (args, hre) => {
        console.log('\n=== CLEAN TRANSFER (expect DELIVERED) ===\n')
        await hre.run('demo:send', { to: args.to, dst: args.dst, amount: args.amount })
    })

task('demo:veto', `Send ${OAPP_CONTRACT} to the FLAGGED recipient — expect VETO (never delivered)`)
    .addOptionalParam('dst', 'destination: base|opt', 'base')
    .addOptionalParam('amount', 'human amount', '1')
    .setAction(async (args, hre) => {
        const flagged = process.env.TEST_DENYLIST
        if (!flagged || flagged.trim() === '') {
            throw new Error('set TEST_DENYLIST in .env to a flagged recipient address')
        }
        console.log('\n=== FLAGGED TRANSFER (expect VETO -> never delivered) ===\n')
        console.log('Flagged recipient:', flagged)
        await hre.run('demo:send', { to: flagged, dst: args.dst, amount: args.amount })
    })

task('demo:show', `Read-only: show ${OAPP_CONTRACT} balances for clean + flagged recipients on destination chain`)
    .addOptionalParam('dst', 'destination: base|opt', 'base')
    .setAction(async (args, hre) => {
        const flagged = process.env.TEST_DENYLIST || ''

        const rpc =
            args.dst === 'opt'
                ? process.env.RPC_URL_OPTIMISM_SEPOLIA || 'https://sepolia.optimism.io'
                : process.env.RPC_URL_BASE_SEPOLIA || 'https://sepolia.base.org'

        const provider = new hre.ethers.providers.JsonRpcProvider(rpc)

        // Read the token address from the DESTINATION network's deployment record. Balances have to
        // be read on the chain the transfer landed on, and the address used to be a hardcoded
        // constant — which silently reported balances for an unrelated token after any redeploy.
        const dstNetwork = args.dst === 'opt' ? 'optimism-sepolia' : 'base-sepolia'
        const recordPath = path.join(__dirname, '..', 'deployments', dstNetwork, `${OAPP_CONTRACT}.json`)
        if (!existsSync(recordPath)) {
            throw new Error(`no ${OAPP_CONTRACT} deployment found for ${dstNetwork} — deploy it there first`)
        }
        const tokenAddress = (JSON.parse(readFileSync(recordPath, 'utf8')) as { address: string }).address
        const token = new hre.ethers.Contract(tokenAddress, ERC20_ABI, provider)

        const cleanBal = await token.balanceOf(CLEAN_RECIPIENT)
        const cleanFmt = hre.ethers.utils.formatEther(cleanBal)

        const network = args.dst === 'opt' ? 'Optimism Sepolia' : 'Base Sepolia'
        console.log(`\n=== ${OAPP_CONTRACT} balances on ${network} (${tokenAddress}) ===\n`)
        console.log(`CLEAN   ${CLEAN_RECIPIENT} : ${cleanFmt}   (delivered)`)

        if (flagged) {
            const flaggedBal = await token.balanceOf(flagged)
            const flaggedFmt = hre.ethers.utils.formatEther(flaggedBal)
            console.log(`FLAGGED ${flagged} : ${flaggedFmt}  (vetoed, never delivered)`)
        } else {
            console.log('FLAGGED <not set>  — set TEST_DENYLIST in .env to see the vetoed balance')
        }
        console.log()
    })
