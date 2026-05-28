import "server-only";

/**
 * Server-only helpers to upload files and JSON metadata to IPFS via Pinata.
 *
 * Requires the PINATA_JWT environment variable to be set with a valid
 * Pinata API JWT token.
 */

type PinataUploadResponse = {
  IpfsHash: string;
};

const PINATA_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PINATA_JSON_URL = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

function getPinataJwt(): string | null {
  return process.env.PINATA_JWT?.trim() ?? null;
}

/** Check whether the Pinata JWT is configured. */
export function isPinataConfigured(): boolean {
  return Boolean(getPinataJwt());
}

function getAuthHeaders(): { Authorization: string } {
  const jwt = getPinataJwt();
  if (!jwt) {
    throw new Error(
      "PINATA_JWT environment variable is not set. " +
        "A Pinata JWT is required to upload to IPFS."
    );
  }
  return { Authorization: `Bearer ${jwt}` };
}

/**
 * Upload a binary buffer (e.g. an image) to IPFS via Pinata.
 *
 * @param buffer - The file contents as a Buffer
 * @param fileName - Name used for the pinned file
 * @param contentType - MIME type, defaults to "image/png"
 * @returns The IPFS CID hash
 */
export async function uploadBufferToIpfs(
  buffer: Buffer,
  fileName: string,
  contentType = "image/png"
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: contentType });
  formData.append("file", blob, fileName);

  const response = await fetch(PINATA_FILE_URL, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Pinata file upload failed (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as PinataUploadResponse;
  return data.IpfsHash;
}

/**
 * Upload JSON metadata to IPFS via Pinata.
 *
 * @param data - The JSON payload to pin
 * @param name - Optional name for Pinata metadata (helps organize pins)
 * @returns The IPFS CID hash
 */
export async function uploadJsonToIpfs(
  data: Record<string, unknown>,
  name?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    pinataContent: data,
  };

  if (name) {
    body.pinataMetadata = { name };
  }

  const response = await fetch(PINATA_JSON_URL, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata upload failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as PinataUploadResponse;
  return result.IpfsHash;
}
