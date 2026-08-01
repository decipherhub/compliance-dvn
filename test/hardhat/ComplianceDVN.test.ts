import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, Contract, ContractTransaction } from 'ethers'
import { ethers } from 'hardhat'

/**
 * Contract-level tests for ComplianceDVN, runnable with `pnpm test:hardhat`.
 *
 * These mirror the foundry suite so the contract can be verified without a `forge` toolchain,
 * which matters most right before a testnet deployment.
 *
 * This project does not install @nomicfoundation/hardhat-chai-matchers, so reverts and events
 * are asserted with plain chai plus explicit log parsing rather than `.to.emit()` sugar.
 */
describe('ComplianceDVN', () => {
    const ACTION = { ALLOW: 0, DELAY: 1, MANUAL_REVIEW: 2, BLOCK: 3 }
    const PAYLOAD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('payload'))
    const EVIDENCE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('evidence'))
    const ZERO32 = ethers.constants.HashZero

    let owner: SignerWithAddress
    let operator: SignerWithAddress
    let stranger: SignerWithAddress
    let sendLib: SignerWithAddress
    let dvn: Contract
    let receiveUln: Contract

    /** Assert the call reverts and that the revert names `expected`. */
    async function expectRevert(call: Promise<unknown>, expected: string): Promise<void> {
        const sentinel = `__expected revert (${expected}) but the call succeeded__`
        try {
            await call
            throw new Error(sentinel)
        } catch (err) {
            const message = (err as Error).message
            if (message === sentinel) throw err
            expect(message, `revert for ${expected}`).to.contain(expected)
        }
    }

    /** Parse the named event out of a transaction's own logs. */
    async function eventArgs(tx: Promise<ContractTransaction>, contract: Contract, name: string) {
        const receipt = await (await tx).wait()
        const found = receipt.logs
            .filter((log) => log.address.toLowerCase() === contract.address.toLowerCase())
            .map((log) => {
                try {
                    return contract.interface.parseLog(log)
                } catch {
                    return undefined
                }
            })
            .find((parsed) => parsed?.name === name)
        expect(found, `event ${name} was not emitted`).to.not.be.undefined
        return found!.args
    }

    before(async () => {
        ;[owner, operator, stranger, sendLib] = await ethers.getSigners()
    })

    beforeEach(async () => {
        receiveUln = await (await ethers.getContractFactory('ReceiveUlnMock')).deploy()
        const DVN = await ethers.getContractFactory('ComplianceDVN')
        dvn = await DVN.deploy(owner.address, operator.address, sendLib.address, receiveUln.address, 0)
        await dvn.deployed()
    })

    // Part of the event ABI: an indexer decoding old logs depends on these staying put.
    it('pins the action codes', async () => {
        expect(await dvn.ACTION_ALLOW()).to.equal(ACTION.ALLOW)
        expect(await dvn.ACTION_DELAY()).to.equal(ACTION.DELAY)
        expect(await dvn.ACTION_MANUAL_REVIEW()).to.equal(ACTION.MANUAL_REVIEW)
        expect(await dvn.ACTION_BLOCK()).to.equal(ACTION.BLOCK)
    })

    describe('submitVerification', () => {
        it('forwards the attestation to the ULN and emits the verdict in one call', async () => {
            const args = await eventArgs(
                dvn.connect(operator).submitVerification('0x0102', PAYLOAD, 7, ACTION.ALLOW, 12, 5, EVIDENCE),
                dvn,
                'RiskVerdict'
            )
            expect(args.payloadHash).to.equal(PAYLOAD)
            expect(args.action).to.equal(ACTION.ALLOW)
            expect(args.score).to.equal(12)
            expect((args.reasonMask as BigNumber).toString()).to.equal('5')
            expect(args.evidenceHash).to.equal(EVIDENCE)

            expect((await receiveUln.calls()).toString()).to.equal('1')
            expect(await receiveUln.lastHeader()).to.equal('0x0102')
            expect(await receiveUln.lastPayloadHash()).to.equal(PAYLOAD)
            expect((await receiveUln.lastConfirmations()).toString()).to.equal('7')
        })

        it('rejects a caller that is not the operator', async () => {
            await expectRevert(
                dvn.connect(stranger).submitVerification('0x01', PAYLOAD, 5, ACTION.ALLOW, 0, 0, ZERO32),
                'NotOperator'
            )
        })

        // A packet that was blocked or held cannot also have been verified: the audit trail must
        // not be able to contradict itself.
        it('rejects any action other than allow, without reaching the ULN', async () => {
            for (const action of [ACTION.DELAY, ACTION.MANUAL_REVIEW, ACTION.BLOCK]) {
                await expectRevert(
                    dvn.connect(operator).submitVerification('0x01', PAYLOAD, 5, action, 0, 0, ZERO32),
                    'VerificationRequiresAllow'
                )
            }
            expect((await receiveUln.calls()).toString()).to.equal('0')
        })
    })

    describe('recordVerdict', () => {
        it('emits the verdict for the operator', async () => {
            const args = await eventArgs(
                dvn.connect(operator).recordVerdict(PAYLOAD, ACTION.BLOCK, 100, 1, EVIDENCE),
                dvn,
                'RiskVerdict'
            )
            expect(args.action).to.equal(ACTION.BLOCK)
            expect(args.score).to.equal(100)
            expect(args.evidenceHash).to.equal(EVIDENCE)
        })

        // The worker's reason mask uses bit 255 for unmapped codes, so the full width must survive.
        it('carries a full uint256 reason mask intact', async () => {
            const mask = BigNumber.from(1).shl(255).or(BigNumber.from(1).shl(4))
            const args = await eventArgs(
                dvn.connect(operator).recordVerdict(PAYLOAD, ACTION.MANUAL_REVIEW, 70, mask, EVIDENCE),
                dvn,
                'RiskVerdict'
            )
            expect((args.reasonMask as BigNumber).toString()).to.equal(mask.toString())
        })

        it('rejects a caller that is not the operator', async () => {
            await expectRevert(
                dvn.connect(stranger).recordVerdict(PAYLOAD, ACTION.BLOCK, 100, 1, ZERO32),
                'NotOperator'
            )
        })

        // An allow rides along on submitVerification; recording one here would double-report it.
        it('rejects allow', async () => {
            await expectRevert(
                dvn.connect(operator).recordVerdict(PAYLOAD, ACTION.ALLOW, 0, 0, ZERO32),
                'AllowNotSeparatelyRecorded'
            )
        })

        it('rejects an out-of-range action', async () => {
            await expectRevert(dvn.connect(operator).recordVerdict(PAYLOAD, 4, 0, 0, ZERO32), 'UnknownAction')
        })
    })

    describe('approvePacket', () => {
        it('emits for the owner', async () => {
            const args = await eventArgs(dvn.connect(owner).approvePacket(PAYLOAD), dvn, 'PacketApproved')
            expect(args.payloadHash).to.equal(PAYLOAD)
            expect(args.approver).to.equal(owner.address)
        })

        // The whole point of owner-gating: the worker holds only the operator key, so it cannot
        // release the packets it chose to withhold.
        it('rejects the operator', async () => {
            await expectRevert(dvn.connect(operator).approvePacket(PAYLOAD), 'OwnableUnauthorizedAccount')
        })

        it('rejects a stranger', async () => {
            await expectRevert(dvn.connect(stranger).approvePacket(PAYLOAD), 'OwnableUnauthorizedAccount')
        })
    })

    describe('assignJob', () => {
        const param = {
            dstEid: 40245,
            packetHeader: '0x01',
            payloadHash: PAYLOAD,
            confirmations: 5,
            sender: '0x0000000000000000000000000000000000001234',
        }

        // SendUln302 calls assignJob with msg.value == 0 (it accrues worker fees internally), so
        // requiring payment here would revert every real send.
        it('succeeds with zero value and returns the fee quote', async () => {
            const fee = ethers.utils.parseEther('0.00005')
            const DVN = await ethers.getContractFactory('ComplianceDVN')
            const paid = await DVN.deploy(owner.address, operator.address, sendLib.address, receiveUln.address, fee)
            const quoted: BigNumber = await paid.connect(sendLib).callStatic.assignJob(param, '0x', { value: 0 })
            expect(quoted.toString()).to.equal(fee.toString())
            const args = await eventArgs(
                paid.connect(sendLib).assignJob(param, '0x', { value: 0 }),
                paid,
                'JobAssigned'
            )
            expect(args.payloadHash).to.equal(PAYLOAD)
        })

        // The worker treats a JobAssigned payloadHash as "ours to screen" and spends operator gas
        // verifying it, so anyone able to assign jobs could point the worker at packets no one
        // asked it to verify.
        it('rejects a caller that is not the send library', async () => {
            await expectRevert(dvn.connect(stranger).assignJob(param, '0x', { value: 0 }), 'NotSendLibrary')
            await expectRevert(dvn.connect(owner).assignJob(param, '0x', { value: 0 }), 'NotSendLibrary')
        })

        it('follows a setSendUln change', async () => {
            await dvn.connect(owner).setSendUln(stranger.address)
            const args = await eventArgs(dvn.connect(stranger).assignJob(param, '0x', { value: 0 }), dvn, 'JobAssigned')
            expect(args.payloadHash).to.equal(PAYLOAD)
            await expectRevert(dvn.connect(sendLib).assignJob(param, '0x', { value: 0 }), 'NotSendLibrary')
        })
    })
})
