// Commit-reveal contract for loot box randomness on Algorand.
//
// Uses a commit-reveal pattern with Algorand's on-chain VRF block seed: the
// user commits (recording the current round) in an atomic group with a payment
// to the treasury, waits at least MIN_WAIT_ROUNDS rounds, then reveals to read
// the VRF seed from the block after their commit. The seed is hashed with the
// caller's address so that two accounts committing in the same round receive
// independent results, and a raw uint64 is returned via ABI return. The server
// maps that value to a prize off-chain.
//
// Algorand only retains block headers for ~1000 rounds, so commits expire after
// EXPIRY_ROUNDS. Expired commits can be cleaned up by anyone via reclaim(),
// which frees the box and returns its minimum-balance to the app account; the
// creator can recover that balance with withdraw().
//
// The contract is intentionally immutable (no update/delete handlers) so the
// rules can never change after deployment. It never custodies prize funds —
// payments go to the treasury and prizes are sent from a separate wallet — so
// the only ALGO it holds is box minimum-balance funding.

import type { uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Account,
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

// Minimum rounds to wait after commit before the block seed is available
// (the reveal requires Global.round strictly greater than commitRound + this).
const MIN_WAIT_ROUNDS: uint64 = 8
// Conservative expiry within the ~1000-round block-header retention window.
const EXPIRY_ROUNDS: uint64 = 900

export class LootBoxCommitReveal extends Contract {
  commitRound = BoxMap<Account, uint64>({ keyPrefix: 'c' })
  treasuryAddress = GlobalState<Account>({ key: 'treasury' })
  cratePrice = GlobalState<uint64>({ key: 'price' })

  @abimethod({ onCreate: 'require' })
  createApplication(treasury: Account, price: uint64): void {
    this.treasuryAddress.value = treasury
    this.cratePrice.value = price
  }

  @abimethod()
  configure(treasury: Account, price: uint64): void {
    assert(Txn.sender === Global.creatorAddress, 'Only the creator can configure')
    this.treasuryAddress.value = treasury
    this.cratePrice.value = price
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
    const committed = this.commitRound(Txn.sender).value

    assert(Global.round > committed + MIN_WAIT_ROUNDS, 'Must wait at least 8 rounds after commit')
    assert(Global.round < committed + EXPIRY_ROUNDS, 'Commit expired — call reclaim() and recommit')

    // VRF block seed of the block after the commit. It is shared by everyone
    // whose commit resolves to the same block, so hash it with the caller's
    // address to give each account an independent draw.
    const seed = op.Block.blkSeed(committed + Uint64(1))
    const mixed = op.sha256(seed.concat(Txn.sender.bytes))
    const randomValue = op.extractUint64(mixed, Uint64(0))

    this.commitRound(Txn.sender).delete()
    return randomValue
  }

  // Reclaim an EXPIRED commit. Permissionless on purpose: an expired commit can
  // never be revealed (the block seed is gone), so anyone may clean it up. This
  // frees the box and returns its minimum-balance to the app account, so the
  // contract cannot accumulate dead boxes from abandoned commits.
  @abimethod()
  reclaim(target: Account): void {
    assert(this.commitRound(target).exists, 'No commit to reclaim')
    const committed = this.commitRound(target).value
    assert(Global.round >= committed + EXPIRY_ROUNDS, 'Commit has not expired yet')
    this.commitRound(target).delete()
  }

  // Recover freed box minimum-balance / excess funding from the app account.
  // Creator-only. The AVM enforces that the app account stays at or above its
  // minimum balance after the inner payment, so this can never under-fund the
  // boxes of outstanding commits.
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
