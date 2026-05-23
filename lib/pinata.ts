/**
 * Server-only helper to upload JSON metadata to IPFS via Pinata.
 *
 * Requires the PINATA_JWT environment variable to be set with a valid
 * Pinata API JWT token.
 */
export async function uploadJsonToIpfs(
  data: Record<string, unknown>
): Promise<string> {
  const jwt = process.env.PINATA_JWT?.trim();

  if (!jwt) {
    throw new Error(
      "PINATA_JWT environment variable is not set. " +
        "A Pinata JWT is required to upload metadata to IPFS."
    );
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: data,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata upload failed (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.IpfsHash as string;
}
