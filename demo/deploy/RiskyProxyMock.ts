import { type DeployFunction } from 'hardhat-deploy/types'

// Demo sources live outside `contracts/` and are not compiled by the main pipeline; the deploy
// uses the artifact checked in next to them (see demo/README.md to rebuild it).
import artifact from '../prebuilt/RiskyProxyMock.json'

/**
 * Demo decoy for the admin-risk check. Testnet only.
 *
 * The admin defaults to the address the worker's TEST_DENYLIST carries, since the check only fires
 * when the admin is one the risk store has something to say about. Override with RISKY_ADMIN to
 * point it at an OFAC address instead.
 */
const DEFAULT_RISKY_ADMIN = '0x000000000000000000000000000000000000dEaD'

const deploy: DeployFunction = async (hre) => {
    const { deployer } = await hre.getNamedAccounts()
    const admin = (process.env.RISKY_ADMIN ?? '').trim() || DEFAULT_RISKY_ADMIN

    // Any non-zero address makes the implementation slot set, which is what marks it upgradeable.
    const { address } = await hre.deployments.deploy('RiskyProxyMock', {
        contract: { abi: artifact.abi, bytecode: artifact.bytecode },
        from: deployer,
        args: [admin, deployer],
        log: true,
        skipIfAlreadyDeployed: false,
    })
    console.log(`RiskyProxyMock on ${hre.network.name}: ${address} (admin ${admin})`)
}

deploy.tags = ['RiskyProxyMock']
export default deploy
