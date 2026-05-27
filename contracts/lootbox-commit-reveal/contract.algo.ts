// Commit-reveal contract for loot box randomness on Algorand.
//
// Uses a commit-reveal pattern with Algorand's VRF beacon: the user
// commits (records the current round), waits at least 8 rounds, then
// reveals to read the VRF seed from the block after their commit.
// The VRF seed is already cryptographically random, so we extract a
// uint64 directly — no additional PRNG layer is needed for a single
// random value per reveal.
//
// If you need MULTIPLE random values from a single seed (e.g. rolling
// several dice in one transaction), use lib-pcg-avm by Giorgio Ciotti:
// https://github.com/CiottiGiorgio/lib-pcg-avm
//
// Algorand only retains block headers for ~1000 rounds. If a user
// waits too long after committing, the VRF seed becomes inaccessible.
// The reclaim() method lets users clean up expired commits so they
// can recommit.

import { Contract } from "@algorandfoundation/tealscript";

const MIN_WAIT_ROUNDS = 8;
const EXPIRY_ROUNDS = 900;

class LootBoxCommitReveal extends Contract {
  commitRound = BoxMap<Address, uint64>();

  createApplication(): void {}

  commit(): void {
    this.commitRound(this.txn.sender).value = globals.round;
  }

  reveal(): uint64 {
    const committed = this.commitRound(this.txn.sender).value;

    assert(globals.round > committed + MIN_WAIT_ROUNDS, "Must wait at least 8 rounds after commit");
    assert(globals.round < committed + EXPIRY_ROUNDS, "Commit expired — call reclaim() and recommit");

    const seed = blocks[committed + 1].seed;
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
