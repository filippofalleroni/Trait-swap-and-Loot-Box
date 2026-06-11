// Commit-reveal contract for loot box randomness on Algorand.
//
// Uses a commit-reveal pattern with the Algorand Randomness Beacon (an ARC-21
// VRF oracle). The user commits (recording the current round) in an atomic group
// with a payment to the treasury. On reveal, the contract DETERMINISTICALLY
// derives a future beacon round from the commit round and the beacon's cadence,
// fetches that round's VRF value from the beacon (bound to the caller's address
// via the user_data argument so each account gets an independent draw), and
// returns a raw uint64. The server maps that value to a prize off-chain.
//
// The target beacon round is computed by the contract (not chosen by the caller),
// so the outcome cannot be ground by picking a favourable round. The beacon app
// id and cadence live in global state so the same contract works on any network
// (TestNet/MainNet beacons differ) and can be tuned to the beacon's schedule.

import type { bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Account,
  arc4,
  assert,
  BoxMap,
  Contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  op,
  Txn,
  Uint64,
} from '@algorandfoundation/algorand-typescript'

// Target beacon round is at least this many cadence-slots after the commit, so
// its VRF value was unknowable when the user paid.
const MIN_DELAY_SLOTS: uint64 = 2
// Conservative reveal window, kept within the beacon's retention so an
// unexpired commit's beacon round is always still available.
const EXPIRY_ROUNDS: uint64 = 400

export class LootBoxCommitReveal extends Contract {
  commitRound = BoxMap<Account, uint64>({ keyPrefix: 'c' })
  treasuryAddress = GlobalState<Account>({ key: 'treasury' })
  cratePrice = GlobalState<uint64>({ key: 'price' })
  beaconApp = GlobalState<uint64>({ key: 'beacon' })
  beaconCadence = GlobalState<uint64>({ key: 'cadence' })

  @abimethod({ onCreate: 'require' })
  createApplication(treasury: Account, price: uint64, beaconApp: uint64, beaconCadence: uint64): void {
    this.treasuryAddress.value = treasury
    this.cratePrice.value = price
    this.beaconApp.value = beaconApp
    this.beaconCadence.value = beaconCadence
  }

  @abimethod()
  configure(treasury: Account, price: uint64, beaconApp: uint64, beaconCadence: uint64): void {
    assert(Txn.sender === Global.creatorAddress, 'Only the creator can configure')
    this.treasuryAddress.value = treasury
    this.cratePrice.value = price
    this.beaconApp.value = beaconApp
    this.beaconCadence.value = beaconCadence
  }

  @abimethod()
  commit(): void {
    // The commit must be preceded in the atomic group by a payment to the
    // treasury for at least the crate price, from the same sender.
    assert(Txn.groupIndex > Uint64(0), 'Commit must follow its payment in the group')
    const payment = gtxn.PaymentTxn(Txn.groupIndex - Uint64(1))
    assert(payment.receiver === this.treasuryAddress.value, 'Payment must go to the treasury')
    assert(payment.amount >= this.cratePrice.value, 'Payment is below the crate price')
    assert(payment.sender === Txn.sender, 'Payment sender must match the caller')

    // One active commit per account: a second would overwrite the first and
    // lose its payment. The user must reveal() or reclaim() first.
    assert(!this.commitRound(Txn.sender).exists, 'Active commit exists — reveal or reclaim first')

    this.commitRound(Txn.sender).value = Global.round
  }

  @abimethod()
  reveal(): uint64 {
    assert(this.commitRound(Txn.sender).exists, 'No active commit to reveal')
    const committed: uint64 = this.commitRound(Txn.sender).value
    const cadence: uint64 = this.beaconCadence.value

    // Deterministic target: the beacon-published round at least MIN_DELAY_SLOTS
    // cadence-slots after the commit. Caller has no choice of round, so the
    // outcome cannot be ground.
    const slot: uint64 = committed / cadence + MIN_DELAY_SLOTS
    const target: uint64 = slot * cadence

    assert(Global.round > target, 'Beacon round not reached yet')
    assert(Global.round < committed + EXPIRY_ROUNDS, 'Commit expired — call reclaim() and recommit')

    // Fetch the VRF value for `target` from the beacon, bound to the caller's
    // address so each account gets an independent draw. fee: 0 — the inner call
    // fee is covered by the reveal transaction's fee pool.
    const vrf = arc4.decodeArc4<bytes>(
      itxn
        .applicationCall({
          appId: this.beaconApp.value,
          appArgs: [
            arc4.methodSelector('must_get(uint64,byte[])byte[]'),
            new arc4.Uint64(target),
            new arc4.DynamicBytes(Txn.sender.bytes),
          ],
          fee: 0,
        })
        .submit().lastLog,
      'log',
    )
    const randomValue = op.extractUint64(vrf, Uint64(0))

    this.commitRound(Txn.sender).delete()
    return randomValue
  }

  // Reclaim an EXPIRED commit. Permissionless: an expired commit can never be
  // revealed, so anyone may clean it up, freeing the box and returning its MBR
  // to the app account.
  @abimethod()
  reclaim(target: Account): void {
    assert(this.commitRound(target).exists, 'No commit to reclaim')
    const committed = this.commitRound(target).value
    assert(Global.round >= committed + EXPIRY_ROUNDS, 'Commit has not expired yet')
    this.commitRound(target).delete()
  }

  // Recover freed box MBR / excess funding. Creator-only; the AVM keeps the app
  // at/above its minimum balance, so outstanding commit boxes stay funded.
  @abimethod()
  withdraw(amount: uint64): void {
    assert(Txn.sender === Global.creatorAddress, 'Only the creator can withdraw')
    itxn
      .payment({
        receiver: Global.creatorAddress,
        amount: amount,
        fee: 0,
      })
      .submit()
  }
}
