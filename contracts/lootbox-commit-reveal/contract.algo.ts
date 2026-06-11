// Commit-reveal loot box randomness, backed by the Algorand Randomness Beacon.
//
// The user commits in an atomic group with a payment to the treasury. The
// commit DETERMINISTICALLY derives a future beacon round from the current round
// and the beacon's cadence and stores THAT target round in a box, so the target
// is locked at commit time and unaffected by any later config change. On reveal,
// the contract fetches the target round's VRF value from the beacon — bound to
// the caller's address so every account gets an independent draw — and returns
// it as a raw uint64. The server maps that value to a prize off-chain.
//
// Because the target round is computed by the contract (never chosen by the
// caller), the outcome cannot be ground by picking a favourable round. The
// beacon app id and cadence live in global state, so one contract serves any
// network (TestNet/MainNet beacons differ).
//
// ARC-28 events (Committed, Revealed) are emitted so off-chain indexers can
// follow the lifecycle and anyone can audit fairness: for a Revealed event,
// `value == extractUint64(beacon.must_get(round, account))`.

import type { bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Account,
  arc4,
  assert,
  BoxMap,
  Contract,
  emit,
  Global,
  GlobalState,
  gtxn,
  itxn,
  op,
  Txn,
  Uint64,
} from '@algorandfoundation/algorand-typescript'

// The target beacon round is at least this many cadence-slots after the commit,
// so its VRF value was unknowable when the user paid.
const MIN_DELAY_SLOTS: uint64 = 2
// How long after the target round a commit stays revealable. Kept within the
// beacon's retention so the target round's value is always still available;
// after this, the commit can be reclaimed.
const REVEAL_WINDOW_ROUNDS: uint64 = 400

// ARC-28 events with named fields, so off-chain consumers see
// `{ account, target, value }` rather than positional args.
class Committed extends arc4.Struct<{ account: arc4.Address; target: arc4.Uint64 }> {}
class Revealed extends arc4.Struct<{ account: arc4.Address; target: arc4.Uint64; value: arc4.Uint64 }> {}

export class LootBoxCommitReveal extends Contract {
  // Per account: the locked target beacon round to draw randomness from.
  commitTarget = BoxMap<Account, uint64>({ keyPrefix: 'c' })
  treasuryAddress = GlobalState<Account>({ key: 'treasury' })
  cratePrice = GlobalState<uint64>({ key: 'price' })
  beaconApp = GlobalState<uint64>({ key: 'beacon' })
  beaconCadence = GlobalState<uint64>({ key: 'cadence' })

  @abimethod({ onCreate: 'require' })
  createApplication(treasury: Account, price: uint64, beaconApp: uint64, beaconCadence: uint64): void {
    this.setConfig(treasury, price, beaconApp, beaconCadence)
  }

  @abimethod()
  configure(treasury: Account, price: uint64, beaconApp: uint64, beaconCadence: uint64): void {
    assert(Txn.sender === Global.creatorAddress, 'Only the creator can configure')
    this.setConfig(treasury, price, beaconApp, beaconCadence)
  }

  @abimethod()
  commit(payment: gtxn.PaymentTxn): void {
    const account = Txn.sender

    // The payment (referenced as a transaction argument) must pay the treasury
    // at least the crate price, from the same account that is committing.
    assert(payment.receiver === this.treasuryAddress.value, 'Payment must go to the treasury')
    assert(payment.amount >= this.cratePrice.value, 'Payment is below the crate price')
    assert(payment.sender === account, 'Payment sender must match the caller')

    // One active commit per account: a second would overwrite the first and
    // lose its payment. The user must reveal() or reclaim() first.
    assert(!this.commitTarget(account).exists, 'Active commit exists — reveal or reclaim first')

    // Lock the target beacon round now, so later config changes can't move it.
    const target: uint64 = this.targetRound(Global.round)
    this.commitTarget(account).value = target
    emit(new Committed({ account: new arc4.Address(account), target: new arc4.Uint64(target) }))
  }

  @abimethod()
  reveal(): uint64 {
    const account = Txn.sender
    assert(this.commitTarget(account).exists, 'No active commit to reveal')
    const target: uint64 = this.commitTarget(account).value

    assert(Global.round > target, 'Beacon round not reached yet')
    assert(Global.round < target + REVEAL_WINDOW_ROUNDS, 'Commit expired — call reclaim() and recommit')

    // Effects before interactions: clear the commit, then make the external
    // beacon call. (A revert undoes both, and the beacon cannot re-enter us.)
    this.commitTarget(account).delete()
    const randomValue: uint64 = this.drawRandomness(target, account)

    emit(new Revealed({ account: new arc4.Address(account), target: new arc4.Uint64(target), value: new arc4.Uint64(randomValue) }))
    return randomValue
  }

  // Reclaim an EXPIRED commit. Permissionless: an expired commit can never be
  // revealed, so anyone may clean it up, freeing the box and returning its MBR
  // to the app account.
  @abimethod()
  reclaim(account: Account): void {
    assert(this.commitTarget(account).exists, 'No commit to reclaim')
    const target = this.commitTarget(account).value
    assert(Global.round >= target + REVEAL_WINDOW_ROUNDS, 'Commit has not expired yet')
    this.commitTarget(account).delete()
  }

  // Recover freed box MBR / excess funding. Creator-only; the AVM keeps the app
  // at or above its minimum balance, so outstanding commit boxes stay funded.
  @abimethod()
  withdraw(amount: uint64): void {
    assert(Txn.sender === Global.creatorAddress, 'Only the creator can withdraw')
    itxn.payment({ receiver: Global.creatorAddress, amount: amount, fee: 0 }).submit()
  }

  // --- private subroutines ---------------------------------------------------

  private setConfig(treasury: Account, price: uint64, beaconApp: uint64, beaconCadence: uint64): void {
    assert(price > Uint64(0), 'Crate price must be positive')
    assert(beaconApp > Uint64(0), 'Beacon app id is required')
    assert(beaconCadence > Uint64(0), 'Beacon cadence must be positive')
    this.treasuryAddress.value = treasury
    this.cratePrice.value = price
    this.beaconApp.value = beaconApp
    this.beaconCadence.value = beaconCadence
  }

  // The deterministic beacon round for a commit made at `committedRound`: the
  // first beacon-published round at least MIN_DELAY_SLOTS cadence-slots later.
  private targetRound(committedRound: uint64): uint64 {
    const cadence: uint64 = this.beaconCadence.value
    return (committedRound / cadence + MIN_DELAY_SLOTS) * cadence
  }

  // Fetch the VRF value for `round` from the beacon, bound to `account` so each
  // caller gets an independent draw, and reduce it to a uint64. fee: 0 — the
  // inner-call fee is covered by the outer reveal transaction's fee pool.
  private drawRandomness(round: uint64, account: Account): uint64 {
    const vrf = arc4.decodeArc4<bytes>(
      itxn
        .applicationCall({
          appId: this.beaconApp.value,
          appArgs: [
            arc4.methodSelector('must_get(uint64,byte[])byte[]'),
            new arc4.Uint64(round),
            new arc4.DynamicBytes(account.bytes),
          ],
          fee: 0,
        })
        .submit().lastLog,
      'log',
    )
    return op.extractUint64(vrf, Uint64(0))
  }
}
