import { parseEther } from 'ethers/lib/utils'
import { type HardhatRuntimeEnvironment } from 'hardhat/types'
import { type DeployFunction } from 'hardhat-deploy/types'

const SEND_ULN: Record<number, string> = {
    40245: '0xC1868e054425D378095A003EcbA3823a5D0135C9', // base-sepolia
    40232: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f', // optimism-sepolia
}

const RECEIVE_ULN: Record<number, string> = {
    40245: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d', // base-sepolia
    40232: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca', // optimism-sepolia
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
    const { deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const eid = (hre.network.config as any).eid as number
    const sendUln = SEND_ULN[eid]
    if (!sendUln) throw new Error(`no SendUln302 for eid ${eid}`)
    const receiveUln = RECEIVE_ULN[eid]
    if (!receiveUln) throw new Error(`no ReceiveUln302 for eid ${eid}`)

    // The owner approves packets held for manual review; the operator (the worker's key)
    // verifies them. Keeping them distinct is what stops the worker from releasing its own
    // holds — see `approvePacket` in ComplianceDVN.sol. Set OPERATOR_ADDRESS to the worker's
    // key to get that separation; without it both roles collapse onto the deployer, which is
    // fine for a demo but gives the worker approval rights.
    const operator = (process.env.OPERATOR_ADDRESS ?? '').trim() || deployer
    if (!EVM_ADDRESS.test(operator)) {
        throw new Error(`OPERATOR_ADDRESS must be a 20-byte EVM address, got '${operator}'`)
    }
    if (operator.toLowerCase() === deployer.toLowerCase()) {
        console.warn(
            `[ComplianceDVN] operator == owner (${deployer}). The worker will be able to approve its own held packets. Set OPERATOR_ADDRESS to separate the roles.`
        )
    }

    await deploy('ComplianceDVN', {
        from: deployer,
        args: [deployer, operator, sendUln, receiveUln, parseEther('0.00005')],
        log: true,
    })
}
deploy.tags = ['ComplianceDVN']
export default deploy
