import { type DeployFunction } from 'hardhat-deploy/types'

// Demo sources live outside `contracts/` and are not compiled by the main pipeline; the deploy
// uses the artifact checked in next to them (see demo/README.md to rebuild it).
import artifact from '../prebuilt/FakeStablecoinMock.json'

/**
 * Demo decoy for the impersonation check. Testnet only.
 *
 * Deployed on both chains so it can stand in as a recipient in either direction: the OFT recipient
 * is screened against the DESTINATION chain's state, so the decoy has to exist there.
 */
const deploy: DeployFunction = async (hre) => {
    const { deployer } = await hre.getNamedAccounts()
    const { address } = await hre.deployments.deploy('FakeStablecoinMock', {
        contract: { abi: artifact.abi, bytecode: artifact.bytecode },
        from: deployer,
        args: [],
        log: true,
        skipIfAlreadyDeployed: false,
    })
    console.log(`FakeStablecoinMock on ${hre.network.name}: ${address}`)
}

deploy.tags = ['FakeStablecoinMock']
export default deploy
