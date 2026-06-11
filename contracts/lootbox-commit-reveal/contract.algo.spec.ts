import { Uint64 } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, it } from 'vitest'
import { LootBoxCommitReveal } from './contract.algo'

const BEACON = 600011887
const CADENCE = 8
const PRICE = 1_000_000
const EXPIRY = 400

describe('LootBoxCommitReveal', () => {
  const ctx = new TestExecutionContext()
  afterEach(() => ctx.reset())

  function deploy() {
    const contract = ctx.contract.create(LootBoxCommitReveal)
    const treasury = ctx.any.account()
    contract.createApplication(treasury, Uint64(PRICE), Uint64(BEACON), Uint64(CADENCE))
    return { contract, treasury }
  }

  describe('config validation', () => {
    it('rejects a zero beacon cadence', () => {
      const c = ctx.contract.create(LootBoxCommitReveal)
      expect(() => c.createApplication(ctx.any.account(), Uint64(PRICE), Uint64(BEACON), Uint64(0))).toThrow(/cadence/)
    })

    it('rejects a zero beacon app id', () => {
      const c = ctx.contract.create(LootBoxCommitReveal)
      expect(() => c.createApplication(ctx.any.account(), Uint64(PRICE), Uint64(0), Uint64(CADENCE))).toThrow(/Beacon app id/)
    })

    it('rejects a zero crate price', () => {
      const c = ctx.contract.create(LootBoxCommitReveal)
      expect(() => c.createApplication(ctx.any.account(), Uint64(0), Uint64(BEACON), Uint64(CADENCE))).toThrow(/price/)
    })

    it('stores a valid config', () => {
      const { contract } = deploy()
      expect(contract.cratePrice.value).toEqual(Uint64(PRICE))
      expect(contract.beaconCadence.value).toEqual(Uint64(CADENCE))
      expect(contract.beaconApp.value).toEqual(Uint64(BEACON))
    })
  })

  describe('configure', () => {
    it('rejects a non-creator', () => {
      const { contract, treasury } = deploy()
      const stranger = ctx.any.account()
      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: contract, sender: stranger })])
        .execute(() => {
          expect(() => contract.configure(treasury, Uint64(PRICE), Uint64(BEACON), Uint64(CADENCE))).toThrow(/creator/)
        })
    })
  })

  describe('commit', () => {
    it('records a commit for a valid payment', () => {
      const { contract, treasury } = deploy()
      const user = ctx.defaultSender
      const payment = ctx.any.txn.payment({ sender: user, receiver: treasury, amount: Uint64(PRICE) })
      ctx.txn
        .createScope([payment, ctx.any.txn.applicationCall({ appId: contract, sender: user })], 1)
        .execute(() => {
          contract.commit(payment)
        })
      expect(contract.commitRound(user).exists).toBe(true)
    })

    it('rejects an underpayment', () => {
      const { contract, treasury } = deploy()
      const user = ctx.defaultSender
      const payment = ctx.any.txn.payment({ sender: user, receiver: treasury, amount: Uint64(PRICE - 1) })
      ctx.txn
        .createScope([payment, ctx.any.txn.applicationCall({ appId: contract, sender: user })], 1)
        .execute(() => {
          expect(() => contract.commit(payment)).toThrow(/below the crate price/)
        })
    })

    it('rejects a payment to the wrong receiver', () => {
      const { contract } = deploy()
      const user = ctx.defaultSender
      const payment = ctx.any.txn.payment({ sender: user, receiver: ctx.any.account(), amount: Uint64(PRICE) })
      ctx.txn
        .createScope([payment, ctx.any.txn.applicationCall({ appId: contract, sender: user })], 1)
        .execute(() => {
          expect(() => contract.commit(payment)).toThrow(/treasury/)
        })
    })

    it('rejects a payment from a different sender', () => {
      const { contract, treasury } = deploy()
      const user = ctx.defaultSender
      const payment = ctx.any.txn.payment({ sender: ctx.any.account(), receiver: treasury, amount: Uint64(PRICE) })
      ctx.txn
        .createScope([payment, ctx.any.txn.applicationCall({ appId: contract, sender: user })], 1)
        .execute(() => {
          expect(() => contract.commit(payment)).toThrow(/sender/)
        })
    })

    it('rejects a second active commit', () => {
      const { contract, treasury } = deploy()
      const user = ctx.defaultSender
      contract.commitRound(user).value = Uint64(100)
      const payment = ctx.any.txn.payment({ sender: user, receiver: treasury, amount: Uint64(PRICE) })
      ctx.txn
        .createScope([payment, ctx.any.txn.applicationCall({ appId: contract, sender: user })], 1)
        .execute(() => {
          expect(() => contract.commit(payment)).toThrow(/Active commit exists/)
        })
    })
  })

  describe('reveal guards', () => {
    // target = (committed / cadence + 2) * cadence; for committed=1000, cadence=8 => 1016
    it('rejects with no active commit', () => {
      const { contract } = deploy()
      expect(() => contract.reveal()).toThrow(/No active commit/)
    })

    it('rejects before the target beacon round', () => {
      const { contract } = deploy()
      contract.commitRound(ctx.defaultSender).value = Uint64(1000)
      ctx.ledger.patchGlobalData({ round: Uint64(1010) }) // < target 1016
      expect(() => contract.reveal()).toThrow(/not reached yet/)
    })

    it('rejects an expired commit', () => {
      const { contract } = deploy()
      contract.commitRound(ctx.defaultSender).value = Uint64(1000)
      ctx.ledger.patchGlobalData({ round: Uint64(1000 + EXPIRY) })
      expect(() => contract.reveal()).toThrow(/expired/)
    })
  })

  describe('reclaim', () => {
    it('rejects a non-existent commit', () => {
      const { contract } = deploy()
      expect(() => contract.reclaim(ctx.any.account())).toThrow(/No commit to reclaim/)
    })

    it('rejects a commit that has not expired', () => {
      const { contract } = deploy()
      const user = ctx.any.account()
      contract.commitRound(user).value = Uint64(1000)
      ctx.ledger.patchGlobalData({ round: Uint64(1000 + EXPIRY - 1) })
      expect(() => contract.reclaim(user)).toThrow(/has not expired/)
    })

    it('deletes an expired commit (permissionless — caller is not the box owner)', () => {
      const { contract } = deploy()
      const user = ctx.any.account() // box owner, distinct from the default caller
      contract.commitRound(user).value = Uint64(1000)
      ctx.ledger.patchGlobalData({ round: Uint64(1000 + EXPIRY) })
      contract.reclaim(user)
      expect(contract.commitRound(user).exists).toBe(false)
    })
  })

  describe('withdraw', () => {
    it('rejects a non-creator', () => {
      const { contract } = deploy()
      const stranger = ctx.any.account()
      ctx.txn
        .createScope([ctx.any.txn.applicationCall({ appId: contract, sender: stranger })])
        .execute(() => {
          expect(() => contract.withdraw(Uint64(1))).toThrow(/creator/)
        })
    })
  })
})
