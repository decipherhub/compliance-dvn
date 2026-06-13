import { task } from 'hardhat/config'

import { EndpointId } from '@layerzerolabs/lz-definitions'

task('demo:send', 'Send ToyOFT from current network to the other testnet')
    .addParam('to', 'recipient address on destination')
    .addOptionalParam('dst', 'destination: base|opt', 'base')
    .addOptionalParam('amount', 'human amount', '1')
    .setAction(async (args, hre) => {
        const dstEid = args.dst === 'opt' ? EndpointId.OPTSEP_V2_TESTNET : EndpointId.BASESEP_V2_TESTNET
        const { deployer } = await hre.getNamedAccounts()
        const d = await hre.deployments.get('ToyOFT')
        const oft = await hre.ethers.getContractAt('ToyOFT', d.address)

        const amount = hre.ethers.utils.parseEther(args.amount)
        await (await oft.mint(deployer, amount)).wait()

        const to = hre.ethers.utils.hexZeroPad(args.to, 32)
        // Build executor options (lzReceive gas). Use the project's options utility.
        const { Options } = await import('@layerzerolabs/lz-v2-utilities')
        const options = Options.newOptions().addExecutorLzReceiveOption(200000, 0).toHex()

        const sendParam = {
            dstEid,
            to,
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: options,
            composeMsg: '0x',
            oftCmd: '0x',
        }
        const fee = await oft.quoteSend(sendParam, false)
        const tx = await oft.send(sendParam, fee, deployer, { value: fee.nativeFee })
        const receipt = await tx.wait()
        console.log('sent tx:', receipt.transactionHash)
        console.log('scan:', `https://testnet.layerzeroscan.com/tx/${receipt.transactionHash}`)
    })
