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
// EXPIRY_ROUNDS and can be cleaned up with reclaim().

import type { bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import {
  abimethod,
  Account,
  assert,
  BoxMap,
  Contract,
  Global,
  GlobalState,
  gtxn,
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

  @abimethod()
  reclaim(): void {
    const committed = this.commitRound(Txn.sender).value
    assert(Global.round >= committed + EXPIRY_ROUNDS, 'Commit has not expired yet')
    this.commitRound(Txn.sender).delete()
  }
}
