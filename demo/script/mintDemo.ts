import { deployments, ethers } from 'hardhat'

/**
 * Mint demo balances: 100 tokens to each demo wallet on the target network.
 *
 *   npx hardhat run demo/script/mintDemo.ts --network base-sepolia
 *   TOKEN=FakeUsdcOFT npx hardhat run demo/script/mintDemo.ts --network base-sepolia
 *
 * `mint` is open on these testnet tokens, so any funded signer can run this.
 */
const TOKEN = (process.env.TOKEN ?? '').trim() || 'MyOFT'
const DEMO_WALLETS: Record<string, string> = {
    owner: '0x8583894d0e57e42abb83039537f314490038efa0',
    worker: '0x01D24AE2cD8ad18472BD00AfE4ec425E800e184d',
    feed: '0xcD346e8762E27d0558a260C1c3562127c52Ad45b',
    clean: '0x25D10657a2642Fe8cd6bEe501dBd0939d79bD90F',
    onehop: '0x9a1c282ebA5e9A97290cAc530902Fb00dcf2ECe2',
}

const AMOUNT = ethers.utils.parseEther('100')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Public RPCs cap in-flight txs per account, so sends are retried with a pause. */
async function mintWithRetry(oft: Awaited<ReturnType<typeof ethers.getContractAt>>, to: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
        try {
            const tx = await oft.mint(to, AMOUNT)
            await tx.wait()
            return tx.hash
        } catch (err) {
            if (attempt >= 5) throw err
            await sleep(5000)
        }
    }
}

async function main(): Promise<void> {
    const { address } = await deployments.get(TOKEN)
    // Both demo tokens are MyOFT instances, so one ABI covers them.
    const oft = await ethers.getContractAt('MyOFT', address)
    console.log(`token ${address} name=${await oft.name()} symbol=${await oft.symbol()}`)

    for (const [label, to] of Object.entries(DEMO_WALLETS)) {
        // Idempotent: a wallet that already holds the demo balance is not topped up again.
        if ((await oft.balanceOf(to)).gte(AMOUNT)) {
            console.log(`skip   -> ${label.padEnd(6)} ${to} (already funded)`)
            continue
        }
        const hash = await mintWithRetry(oft, to)
        console.log(`minted 100 -> ${label.padEnd(6)} ${to} tx=${hash}`)
    }
    for (const [label, to] of Object.entries(DEMO_WALLETS)) {
        console.log(`${label.padEnd(6)} balance: ${ethers.utils.formatEther(await oft.balanceOf(to))}`)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
