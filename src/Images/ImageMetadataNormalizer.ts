import type { ExpandedTags } from 'exifreader';
import type { HeaderDimensions } from './ImageHeaderReader';
import { IMAGE_FACT_FIELDS, type ImageFacts } from './ImageTypes';

type TagValue = unknown;
type Section = Record<string, TagValue>;

const SKIPPED_TAGS: ReadonlySet<string> = new Set(['MakerNote', 'PrintIM', 'PhotoshopSettings', 'ApplicationNotes', 'IPTC-NAA',
  'UserComment', 'image', 'base64', '_raw', 'Global Color Map', 'ToneCurve', 'NativeDigest', 'History']);

const MAX_VALUE_LENGTH = 2000;

const MIME_TYPES: Readonly<Record<string, string>> = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', heic: 'image/heic', tiff: 'image/tiff', jxl: 'image/jxl', xml: 'image/svg+xml' };

export interface NormalizedImage {
  facts: ImageFacts;
  metadata: string | null;
  tagCount: number;
}

const EMPTY_IMAGE_FACTS = Object.fromEntries(IMAGE_FACT_FIELDS.map(({ name }) => [name, null])) as ImageFacts;

export function emptyImageFacts(): ImageFacts {
  return { ...EMPTY_IMAGE_FACTS };
}

/** Coordinates go to Places as text, so they must never reach exponential notation, which its parser rejects. */
export function formatCoordinatePair(latitude: number | null, longitude: number | null): string | null {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  return `${formatCoordinate(latitude)}, ${formatCoordinate(longitude)}`;
}

function formatCoordinate(value: number): string {
  const fixed = value.toFixed(7);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;

  return trimmed === '-0' ? '0' : trimmed;
}

export function normalizeHeaderDimensions(header: HeaderDimensions): NormalizedImage {
  const facts = emptyImageFacts();
  facts.width = header.width;
  facts.height = header.height;
  facts.oriented_width = header.width;
  facts.oriented_height = header.height;
  facts.mime_type = header.mime_type;
  facts.format = header.mime_type.replace(/^image\//, '');

  return { facts, metadata: null, tagCount: 0 };
}

export function normalizeImageTags(tags: ExpandedTags): NormalizedImage {
  const sections = tags as unknown as Record<string, Section | undefined>;
  const facts = emptyImageFacts();
  const exif = sections.exif, xmp = sections.xmp, iptc = sections.iptc, icc = sections.icc;
  const gps = sections.gps as unknown as { Latitude?: number; Longitude?: number; Altitude?: number } | undefined;

  const fileType = text(sections.file?.FileType);
  facts.format = fileType ? fileType.toLowerCase() : null;
  facts.mime_type = facts.format ? MIME_TYPES[facts.format] ?? null : null;

  facts.width = first(number(sections.file?.['Image Width']), number(exif?.PixelXDimension), number(exif?.ImageWidth),
    number(sections.pngFile?.['Image Width']), number(sections.png?.['Image Width']), number(sections.gif?.['Image Width']));

  facts.height = first(number(sections.file?.['Image Height']), number(exif?.PixelYDimension), number(exif?.ImageLength),
    number(sections.pngFile?.['Image Height']), number(sections.png?.['Image Height']), number(sections.gif?.['Image Height']));

  facts.orientation = number(exif?.Orientation);

  const rotated = facts.orientation !== null && facts.orientation >= 5 && facts.orientation <= 8;
  facts.oriented_width = rotated ? facts.height : facts.width;
  facts.oriented_height = rotated ? facts.width : facts.height;

  facts.bit_depth = first(number(sections.file?.['Bits Per Sample']), number(sections.pngFile?.['Bit Depth']), number(sections.gif?.['Bits Per Pixel']));
  facts.color_space = first(text(exif?.ColorSpace), text(icc?.['Color Space']), text(sections.pngFile?.['Color Type']));
  const colorType = text(sections.pngFile?.['Color Type']);
  facts.has_alpha = colorType === null ? null : /alpha/i.test(colorType) ? 1 : 0;
  facts.icc_profile = text(icc?.['ICC Description']);

  const captured = readCapturedTime(exif, xmp);
  facts.captured = captured.epoch;
  facts.captured_local = captured.local;
  facts.captured_offset = captured.offset;

  facts.camera_make = trimmed(first(text(exif?.Make), text(xmp?.Make)));
  facts.camera_model = trimmed(first(text(exif?.Model), text(xmp?.Model)));
  facts.lens_model = trimmed(first(text(exif?.LensModel), text(xmp?.LensModel), text(xmp?.Lens)));
  facts.software = trimmed(first(text(exif?.Software), text(xmp?.CreatorTool)));

  facts.iso = first(number(exif?.ISOSpeedRatings), number(xmp?.ISOSpeedRatings));
  facts.exposure_time = number(exif?.ExposureTime);
  facts.exposure_time_text = text(exif?.ExposureTime);
  facts.f_number = number(exif?.FNumber);
  facts.focal_length = number(exif?.FocalLength);
  facts.focal_length_35mm = first(number(exif?.FocalLengthIn35mmFilm), number(sections.composite?.FocalLength35efl));
  facts.exposure_bias = number(exif?.ExposureBiasValue);
  facts.metering_mode = text(exif?.MeteringMode);
  facts.white_balance = text(exif?.WhiteBalance);
  const flash = rawNumber(exif?.Flash);
  facts.flash_fired = flash === null ? null : flash & 1;

  facts.latitude = finite(gps?.Latitude);
  facts.longitude = finite(gps?.Longitude);
  facts.altitude = first(finite(gps?.Altitude), number(exif?.GPSAltitude));
  facts.location = formatCoordinatePair(facts.latitude, facts.longitude);
  facts.gps_direction = number(exif?.GPSImgDirection);
  facts.gps_direction_ref = firstArrayValue(exif?.GPSImgDirectionRef);
  facts.gps_speed = number(exif?.GPSSpeed);
  facts.gps_timestamp = readGpsTime(exif);

  facts.title = trimmed(first(text(xmp?.title), text(iptc?.['Object Name']), text(exif?.XPTitle)));
  facts.description = trimmed(first(text(xmp?.description), text(exif?.ImageDescription), text(iptc?.['Caption/Abstract'])));
  facts.creator = trimmed(first(text(xmp?.creator), text(exif?.Artist), text(iptc?.['By-line'])));
  facts.copyright = trimmed(first(text(xmp?.rights), text(exif?.Copyright), text(iptc?.['Copyright Notice'])));
  facts.credit = trimmed(text(iptc?.Credit));
  const percent = number(xmp?.RatingPercent);
  // RatingPercent runs 0 to 100 where Rating runs 0 to 5.
  facts.rating = first(number(xmp?.Rating), percent === null ? null : Math.round(percent / 20));
  facts.label = trimmed(text(xmp?.Label));
  facts.keywords = readKeywords(xmp, iptc);
  facts.city = trimmed(first(text(iptc?.City), text(xmp?.City)));
  facts.state = trimmed(first(text(iptc?.['Province-State']), text(xmp?.State)));
  facts.country = trimmed(first(text(iptc?.['Country-PrimaryLocationName']), text(xmp?.Country)));
  facts.sublocation = trimmed(first(text(iptc?.['Sub-location']), text(xmp?.Location)));

  const { json, count } = collectTags(sections);

  return { facts, metadata: json, tagCount: count };
}

function collectTags(sections: Record<string, Section | undefined>): { json: string | null; count: number } {
  const output: Record<string, Record<string, string | number>> = {};
  let count = 0;

  for (const [name, section] of Object.entries(sections)) {
    if (!section || typeof section !== 'object' || name === 'metadataRange') continue;
    const group: Record<string, string | number> = {};

    for (const [tag, value] of Object.entries(section)) {
      if (SKIPPED_TAGS.has(tag)) continue;
      const scalar = scalarOf(value);
      if (scalar === null) continue;
      group[tag] = scalar; count++;
    }

    if (Object.keys(group).length) output[name] = group;
  }

  return { json: count ? JSON.stringify(output) : null, count };
}

function scalarOf(tag: TagValue): string | number | null {
  if (typeof tag === 'number' || typeof tag === 'string') return clamp(tag);
  if (!tag || typeof tag !== 'object') return null;
  const record = tag as { value?: unknown; description?: unknown };
  const description = record.description;
  if (typeof description === 'string' || typeof description === 'number') return clamp(description);
  const value = record.value;
  if (typeof value === 'string' || typeof value === 'number') return clamp(value);

  if (Array.isArray(value) && value.length === 2) {
    const numerator: unknown = value[0];
    const denominator: unknown = value[1];
    if (typeof numerator === 'number' && typeof denominator === 'number') return `${numerator}/${denominator}`;
  }
  if (Array.isArray(value) && value.length && value.every(part => typeof part === 'string')) return clamp(value.join(', '));

  return null;
}

const clamp = (value: string | number): string | number => typeof value === 'string' && value.length > MAX_VALUE_LENGTH
  ? value.slice(0, MAX_VALUE_LENGTH) : value;

function readKeywords(xmp: Section | undefined, iptc: Section | undefined): string | null {
  const collected: string[] = [];

  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) collected.push(value.trim());
    else if (Array.isArray(value)) for (const entry of value) {
      const scalar = scalarOf(entry);
      if (typeof scalar === 'string' && scalar.trim()) collected.push(scalar.trim());
    }
  };

  const subject = xmp?.subject as { value?: unknown; description?: unknown } | undefined;
  if (subject) { add(subject.value); if (!collected.length) add(subject.description); }
  const keywords = iptc?.Keywords as { value?: unknown; description?: unknown } | undefined;
  if (keywords) { add(keywords.value); if (!collected.length) add(keywords.description); }
  const unique = [...new Set(collected)];

  return unique.length ? JSON.stringify(unique) : null;
}

function readCapturedTime(exif: Section | undefined, xmp: Section | undefined): { epoch: number | null; local: string | null; offset: string | null } {
  const raw = first(text(exif?.DateTimeOriginal), text(xmp?.DateTimeOriginal), text(exif?.DateTimeDigitized), text(exif?.DateTime), text(xmp?.CreateDate));
  if (raw === null) return { epoch: null, local: null, offset: null };
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return { epoch: null, local: null, offset: null };
  const [, year, month, day, hour, minute, second] = match;
  const local = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  const embedded = /([+-]\d{2}:\d{2})$/.exec(raw.trim())?.[1] ?? null;
  const offset = first(firstArrayValue(exif?.OffsetTimeOriginal), firstArrayValue(exif?.OffsetTime), embedded);
  const shift = offset ? offsetMinutes(offset) : 0;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const epoch = Number.isFinite(utc) ? utc - shift * 60_000 : null;

  return { epoch, local, offset };
}

function offsetMinutes(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!match) return 0;

  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function readGpsTime(exif: Section | undefined): number | null {
  const stamp = firstArrayValue(exif?.GPSDateStamp) ?? text(exif?.GPSDateStamp);
  const time = exif?.GPSTimeStamp as { value?: unknown; description?: unknown } | undefined;
  if (!stamp) return null;
  const date = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(stamp.trim());
  if (!date) return null;
  const parts = readTimeParts(time);
  const utc = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), parts[0], parts[1], parts[2]);

  return Number.isFinite(utc) ? utc : null;
}

function readTimeParts(time: { value?: unknown; description?: unknown } | undefined): [number, number, number] {
  const description = typeof time?.description === 'string' ? /(\d{1,2}):(\d{2}):(\d{2})/.exec(time.description) : null;
  if (description) return [Number(description[1]), Number(description[2]), Number(description[3])];
  const value = time?.value;

  if (Array.isArray(value) && value.length === 3) {
    const parts = value.map(part => Array.isArray(part) && part.length === 2 && part[1] ? Number(part[0]) / Number(part[1]) : Number(part));
    if (parts.every(part => Number.isFinite(part))) return [Math.trunc(parts[0]), Math.trunc(parts[1]), Math.trunc(parts[2])];
  }

  return [0, 0, 0];
}

function first<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') return value;
  }

  return null;
}

function text(tag: TagValue): string | null {
  const scalar = scalarOf(tag);

  return scalar === null ? null : String(scalar);
}

function number(tag: TagValue): number | null {
  const raw = rawNumber(tag);
  if (raw !== null) return raw;
  const scalar = scalarOf(tag);
  if (scalar === null) return null;
  const parsed = typeof scalar === 'number' ? scalar : Number(String(scalar).replace(/^[^0-9.+-]*/, '').replace(/[^0-9.eE+-].*$/, ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function rawNumber(tag: TagValue): number | null {
  if (typeof tag === 'number') return tag;
  if (!tag || typeof tag !== 'object') return null;
  const value = (tag as { value?: unknown }).value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'number')) {
    const [numerator, denominator] = value as [number, number];

    return denominator === 0 ? null : numerator / denominator;
  }

  return null;
}

function firstArrayValue(tag: TagValue): string | null {
  const value = (tag as { value?: unknown } | undefined)?.value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];

  return null;
}

const finite = (value: number | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function trimmed(value: string | null): string | null {
  const text = value?.trim();

  return text ? text : null;
}
