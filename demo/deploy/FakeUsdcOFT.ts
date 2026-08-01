import { type DeployFunction } from 'hardhat-deploy/types'

/**
 * A sendable decoy stablecoin. Testnet only.
 *
 * The impersonation check runs on the token being MOVED, not on the recipient: the engine resolves
 * a packet's OApp through `token()` and compares that token against the chain's canonical issuer.
 * Demonstrating it therefore needs a fake stablecoin that can actually be sent cross-chain — which
 * means a wired OFT, not a plain contract.
 *
 * This is the same `MyOFT` code as the demo token, deployed under its own name so it gets its own
 * address and its own wiring. Wire it with OAPP_CONTRACT=FakeUsdcOFT.
 */
const deploy: DeployFunction = async (hre) => {
    const { deployer } = await hre.getNamedAccounts()
    const endpointV2 = await hre.deployments.get('EndpointV2')

    const { address } = await hre.deployments.deploy('FakeUsdcOFT', {
        contract: 'MyOFT',
        from: deployer,
        // 'USDC' is what makes it a decoy: a watched symbol from an address that is not Circle's.
        args: ['USD Coin', 'USDC', endpointV2.address, deployer],
        log: true,
        skipIfAlreadyDeployed: false,
    })
    console.log(`FakeUsdcOFT (symbol USDC) on ${hre.network.name}: ${address}`)
}

deploy.tags = ['FakeUsdcOFT']
export default deploy
