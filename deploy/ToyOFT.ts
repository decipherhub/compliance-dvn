import { type DeployFunction } from 'hardhat-deploy/types'
import { type HardhatRuntimeEnvironment } from 'hardhat/types'

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
    const { deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const endpointV2 = await hre.deployments.get('EndpointV2')
    await deploy('ToyOFT', {
        from: deployer,
        args: ['Toy OFT', 'TOY', endpointV2.address, deployer],
        log: true,
    })
}
deploy.tags = ['ToyOFT']
export default deploy
