import { task } from 'hardhat/config'

task('dvn:status', 'Show ComplianceDVN config on the current --network').setAction(async (_args, hre) => {
    const d = await hre.deployments.get('ComplianceDVN')
    const dvn = await hre.ethers.getContractAt('ComplianceDVN', d.address)
    console.log({
        address: d.address,
        operator: await dvn.operator(),
        receiveUln: await dvn.receiveUln(),
        fee: (await dvn.fee()).toString(),
        owner: await dvn.owner(),
    })
})
