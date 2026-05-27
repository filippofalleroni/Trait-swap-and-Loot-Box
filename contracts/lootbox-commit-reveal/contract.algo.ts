// Commit-reveal contract for loot box randomness on Algorand.
//
// Uses a commit-reveal pattern with Algorand's VRF beacon: the user
// commits (recording the current round), waits at least 8 rounds, then
// reveals to read the VRF seed from the block after their commit.
// The VRF seed is already cryptographically random, so we extract a
// uint64 directly — no additional PRNG layer is needed for a single
// random value per reveal.
//
// If you need MULTIPLE random values from a single seed (e.g. rolling
// several dice in one transaction), use lib-pcg-avm by Giorgio Ciotti:
// https://github.com/CiottiGiorgio/lib-pcg-avm
//
// The commit() method enforces that the caller has paid the crate price
// to the treasury by verifying the preceding transaction in the atomic
// group. The treasury address and crate price are stored in global state
// and set at deployment via createApplication(). Only the contract
// creator can update them via configure().
//
// Algorand only retains block headers for ~1000 rounds. If a user
// waits too long after committing, the VRF seed becomes inaccessible.
// The reclaim() method lets users clean up expired commits so they
// can recommit.
//
// Box MBR: Each commit creates a BoxMap entry (32-byte key + 8-byte
// value = 40 bytes → 2500 + 400 * 40 = 18500 microALGO MBR).
// The contract account must be funded with enough ALGO to cover MBR
// for the maximum number of concurrent commits you expect. When a
// commit is deleted (via reveal or reclaim), that MBR is freed.

import { Contract } from "@algorandfoundation/tealscript";

const MIN_WAIT_ROUNDS = 8;
const EXPIRY_ROUNDS = 900;

class LootBoxCommitReveal extends Contract {
  commitRound = BoxMap<Address, uint64>();
  treasuryAddress = GlobalStateKey<Address>();
  cratePrice = GlobalStateKey<uint64>();

  createApplication(treasury: Address, price: uint64): void {
    this.treasuryAddress.value = treasury;
    this.cratePrice.value = price;
  }

  configure(treasury: Address, price: uint64): void {
    assert(this.txn.sender === this.app.creator);
    this.treasuryAddress.value = treasury;
    this.cratePrice.value = price;
  }

  commit(): void {
    // The commit must be the second transaction in an atomic group.
    // The first transaction must be a payment to the treasury for at
    // least the crate price, from the same sender.
    assert(this.txn.groupIndex > 0);
    const payTxn = this.txnGroup[this.txn.groupIndex - 1];
    assert(payTxn.typeEnum === TransactionType.Payment);
    assert(payTxn.receiver === this.treasuryAddress.value);
    assert(payTxn.amount >= this.cratePrice.value);
    assert(payTxn.sender === this.txn.sender);

    this.commitRound(this.txn.sender).value = globals.round;
  }

  reveal(): uint64 {
    const committed = this.commitRound(this.txn.sender).value;

    assert(globals.round > committed + MIN_WAIT_ROUNDS, "Must wait at least 8 rounds after commit");
    assert(globals.round < committed + EXPIRY_ROUNDS, "Commit expired — call reclaim() and recommit");

    const seed = blocks[committed + 1].seed;
    // Extract the first 8 bytes of the VRF seed and convert to uint64.
    const randomValue = btoi(extract3(seed, 0, 8));

    this.commitRound(this.txn.sender).delete();
    return randomValue;
  }

  reclaim(): void {
    const committed = this.commitRound(this.txn.sender).value;
    assert(globals.round >= committed + EXPIRY_ROUNDS, "Commit has not expired yet");
    this.commitRound(this.txn.sender).delete();
  }
}
