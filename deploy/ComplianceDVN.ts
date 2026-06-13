import { parseEther } from 'ethers/lib/utils'
import { type DeployFunction } from 'hardhat-deploy/types'
import { type HardhatRuntimeEnvironment } from 'hardhat/types'

const RECEIVE_ULN: Record<number, string> = {
    40245: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d', // base-sepolia
    40232: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca', // optimism-sepolia
}

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
    const { deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const eid = (hre.network.config as any).eid as number
    const receiveUln = RECEIVE_ULN[eid]
    if (!receiveUln) throw new Error(`no ReceiveUln302 for eid ${eid}`)
    await deploy('ComplianceDVN', {
        from: deployer,
        args: [deployer, deployer, receiveUln, parseEther('0.00005')],
        log: true,
    })
}
deploy.tags = ['ComplianceDVN']
export default deploy
