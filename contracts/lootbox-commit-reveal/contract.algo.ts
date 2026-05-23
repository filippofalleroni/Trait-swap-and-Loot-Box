// Commit-reveal contract for loot box randomness on Algorand.
//
// The PCG32 pseudo-random number generator used here is based on
// lib-pcg-avm by Giorgio Ciotti (https://github.com/CiottiGiorgio/lib-pcg-avm),
// an open-source PCG implementation for the Algorand Virtual Machine.
//
// This contract wraps PCG32 in a commit-reveal pattern: the user commits,
// waits N rounds, then reveals to derive randomness from Algorand's VRF
// beacon seed. Users may need to modify and deploy their own version.

import { Contract } from "@algorandfoundation/tealscript";

class LootBoxCommitReveal extends Contract {
  // PCG32 state
  pcgState = GlobalStateKey<uint64>();
  pcgInc = GlobalStateKey<uint64>();

  // Commit-reveal: maps each sender address to the round they committed at
  commitRound = BoxMap<Address, uint64>();

  createApplication(): void {
    this.pcgState.value = 0;
    this.pcgInc.value = 0;
  }

  commit(): void {
    this.commitRound(this.txn.sender).value = globals.round;
  }

  reveal(): uint64 {
    const committed = this.commitRound(this.txn.sender).value;
    assert(globals.round > committed + 8, "Must wait at least 8 rounds");

    // Use VRF output from the block after commitment for randomness
    const seed = blocks[committed + 1].seed;
    const randomValue = this.pcg32(seed);

    this.commitRound(this.txn.sender).delete();
    return randomValue;
  }

  private pcg32(seed: bytes): uint64 {
    // PCG32 implementation using the VRF seed as entropy source
    const state = btoi(extract3(seed, 0, 8));
    const oldstate = state;
    this.pcgState.value =
      oldstate * 6364136223846793005 + (this.pcgInc.value | 1);
    const xorshifted = (((oldstate >> 18) ^ oldstate) >> 27) as uint64;
    const rot = (oldstate >> 59) as uint64;
    return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
  }
}
