const mp4MajorBrands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'm4v ', 'mmp4', 'msnv']);
const webmDocType = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const hostedFormats = ['png', 'jpg', 'gif', 'webp', 'mp4', 'webm'] as const;

export type HostedMediaFormat = typeof hostedFormats[number];
export const isVideoFormat = (type: string) => type === 'mp4' || type === 'webm';

export const bytesMatch = (bytes: Buffer, type: string) => {
  const at = (offset: number, text: string) => bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  switch (type) {
    case 'png': return at(0, '\x89PNG\r\n\x1a\n') && at(12, 'IHDR');
    case 'jpg': return at(0, '\xff\xd8\xff');
    case 'gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'mp4': return at(4, 'ftyp') && bytes.length >= 16 && mp4MajorBrands.has(bytes.subarray(8, 12).toString('latin1').toLowerCase());
    case 'webm': return at(0, '\x1a\x45\xdf\xa3') && bytes.subarray(4, 256).includes(webmDocType);
    default: return false;
  }
};

export function detectHostedMediaFormat(bytes: Buffer): HostedMediaFormat | null {
  for (const type of hostedFormats) {
    if (bytesMatch(bytes, type)) return type;
  }
  return null;
}
