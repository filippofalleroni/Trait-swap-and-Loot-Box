import "server-only";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { getTraitLayerImageCandidates } from "@/lib/nft-layering";
import type { OfficialTraitCategory } from "@/lib/types";

const PUBLIC_DIR = path.join(process.cwd(), "public");

function getPublicBaseUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

async function resolveLayerBuffer(category: OfficialTraitCategory, traitValue: string): Promise<Buffer | null> {
  const candidates = getTraitLayerImageCandidates(category, traitValue);

  for (const candidate of candidates) {
    const relativePath = candidate.src.replace(/^\//, "");
    const absolutePath = path.join(PUBLIC_DIR, relativePath);
    try {
      await fs.access(absolutePath);
      return await fs.readFile(absolutePath);
    } catch {
      // not found locally
    }
  }

  const base = getPublicBaseUrl();
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${base}${candidate.src}`);
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
    } catch {
      // continue
    }
  }

  return null;
}

export async function composeNftImage(
  layers: Partial<Record<OfficialTraitCategory, string>>,
  layerOrder: OfficialTraitCategory[]
) {
  const resolvedLayers = (
    await Promise.all(
      layerOrder.map(async (category) => {
        const traitValue = layers[category];
        if (!traitValue || traitValue === "None") return null;
        const buffer = await resolveLayerBuffer(category, traitValue);
        if (!buffer) return null;
        return { category, traitValue, buffer };
      })
    )
  ).filter((v): v is NonNullable<typeof v> => Boolean(v));

  if (!resolvedLayers.length) {
    throw new Error("No valid layers were resolved for image composition.");
  }

  const allMeta = await Promise.all(resolvedLayers.map((l) => sharp(l.buffer).metadata()));
  const width = Math.max(...allMeta.map((m) => m.width ?? 0));
  const height = Math.max(...allMeta.map((m) => m.height ?? 0));

  const MAX_DIMENSION = 4096;
  if (!width || !height) {
    throw new Error("Could not determine image dimensions from layers.");
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error("Layer dimensions exceed safe maximum.");
  }

  const compositeInputs = await Promise.all(
    resolvedLayers.map(async (layer, i) => {
      const { width: w, height: h } = allMeta[i];
      const needsResize = w !== width || h !== height;
      const input = needsResize
        ? await sharp(layer.buffer).resize(width, height, { fit: "fill" }).toBuffer()
        : layer.buffer;
      return { input, left: 0, top: 0 };
    })
  );

  const imageBuffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toBuffer();

  return { buffer: imageBuffer, width, height };
}
