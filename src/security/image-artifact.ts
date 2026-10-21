import sharp from 'sharp';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export interface PublicImageArtifact { bytes: Buffer; contentType: `image/${ImageFormat}`; }
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Decode pixels and encode a fresh file. No EXIF, XMP, comments, or upstream chunks survive. */
export async function sanitizeImageArtifact(input: Uint8Array, requestedFormat?: ImageFormat): Promise<PublicImageArtifact> {
  return encodeArtifact(input, requestedFormat, false);
}

export async function sanitizeImageThumbnail(input: Uint8Array): Promise<PublicImageArtifact> {
  return encodeArtifact(input, 'webp', true);
}

async function encodeArtifact(input: Uint8Array, requestedFormat: ImageFormat | undefined, thumbnail: boolean): Promise<PublicImageArtifact> {
  if (!input.byteLength || input.byteLength > MAX_IMAGE_BYTES) throw new Error('Invalid image bytes');
  const source = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning', animated: true });
  const metadata = await source.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1) {
    throw new Error('Unsupported image artifact');
  }
  const format = requestedFormat || metadata.format as ImageFormat;
  // Apply orientation before dropping EXIF; convert profile-dependent pixels to standard sRGB.
  let output = source.rotate().toColourspace('srgb').timeout({ seconds: 15 });
  if (thumbnail) output = output.resize(512, 512, { fit: 'inside', withoutEnlargement: true });
  if (format === 'png') output = output.png();
  else if (format === 'webp') output = output.webp(thumbnail ? { quality: 80, effort: 3 } : { lossless: true });
  else output = output.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  const bytes = await output.toBuffer();
  if (bytes.byteLength > (thumbnail ? 512 * 1024 : MAX_IMAGE_BYTES)) throw new Error('Image output too large');
  return { bytes, contentType: `image/${format}` };
}

export function decodeImageBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid image encoding');
  }
  return Buffer.from(value, 'base64');
}
