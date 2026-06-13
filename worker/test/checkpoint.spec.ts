import { describe, it, expect, afterEach } from 'vitest'
import { Checkpoint } from '../checkpoint'
import { rmSync, existsSync } from 'fs'

const PATH = '/tmp/dvn-checkpoint-test.json'
afterEach(() => { if (existsSync(PATH)) rmSync(PATH) })

describe('Checkpoint', () => {
  it('persists last block per chain and processed packets', () => {
    const c = new Checkpoint(PATH)
    c.setLastBlock('baseSepolia', 100)
    c.markProcessed('0xpackethash')
    c.save()

    const c2 = new Checkpoint(PATH)
    expect(c2.getLastBlock('baseSepolia')).toBe(100)
    expect(c2.isProcessed('0xpackethash')).toBe(true)
    expect(c2.isProcessed('0xother')).toBe(false)
  })
})
