import { NextResponse } from "next/server";

/**
 * GET /api/trait-counts
 *
 * Returns mint counts per trait (how many times each trait has been applied).
 *
 * For the open-source template, this returns an empty object.
 * In production, you would connect this to a database (e.g., Supabase,
 * Vercel KV, or a simple JSON file) to track how many times each
 * trait has been swapped.
 *
 * Expected response format:
 *   { [traitId: string]: number }
 *
 * Example production response:
 *   { "bg-sunset": 42, "top-crown": 7, "eyes-laser": 15 }
 */
export async function GET() {
  // Template default: return empty counts.
  // Replace this with a database query in production.
  //
  // Example with a database:
  // const counts = await db.query("SELECT trait_id, count FROM trait_counts");
  // return NextResponse.json(Object.fromEntries(counts.map(r => [r.trait_id, r.count])));

  return NextResponse.json({});
}
