import type { OtherFileMetadata } from '../OtherFiles/OtherFileTypes';

export type ImageMetadataStatus = 'ready' | 'no_metadata' | 'unsupported' | 'read_error';

export const IMAGE_FACT_FIELDS = [
  { name: 'mime_type', type: 'TEXT', description: 'Media type from the file header' },
  { name: 'format', type: 'TEXT', description: 'Container format, such as jpeg or heic' },
  { name: 'width', type: 'INTEGER', description: 'Stored pixel width' },
  { name: 'height', type: 'INTEGER', description: 'Stored pixel height' },
  { name: 'orientation', type: 'INTEGER', description: 'Exif orientation, 1 to 8' },
  { name: 'oriented_width', type: 'INTEGER', description: 'Displayed width after rotation' },
  { name: 'oriented_height', type: 'INTEGER', description: 'Displayed height after rotation' },
  { name: 'bit_depth', type: 'INTEGER', description: 'Bits per sample' },
  { name: 'color_space', type: 'TEXT', description: 'Color space or PNG color type' },
  { name: 'has_alpha', type: 'INTEGER', description: '1 when the format records transparency' },
  { name: 'icc_profile', type: 'TEXT', description: 'ICC profile description' },
  { name: 'captured', type: 'REAL', description: 'Capture time in milliseconds; UTC when an offset is recorded' },
  { name: 'captured_local', type: 'TEXT', description: 'Capture time as written by the camera' },
  { name: 'captured_offset', type: 'TEXT', description: 'Recorded UTC offset, such as -05:00' },
  { name: 'camera_make', type: 'TEXT', description: 'Camera manufacturer' },
  { name: 'camera_model', type: 'TEXT', description: '' },
  { name: 'lens_model', type: 'TEXT', description: '' },
  { name: 'software', type: 'TEXT', description: 'Creating software' },
  { name: 'iso', type: 'INTEGER', description: '' },
  { name: 'exposure_time', type: 'REAL', description: 'Exposure in seconds' },
  { name: 'exposure_time_text', type: 'TEXT', description: 'Exposure as written, such as 1/250' },
  { name: 'f_number', type: 'REAL', description: 'Aperture f-number' },
  { name: 'focal_length', type: 'REAL', description: 'Focal length in millimeters' },
  { name: 'focal_length_35mm', type: 'REAL', description: '35 mm equivalent focal length' },
  { name: 'exposure_bias', type: 'REAL', description: 'Exposure compensation in stops' },
  { name: 'metering_mode', type: 'TEXT', description: '' },
  { name: 'white_balance', type: 'TEXT', description: '' },
  { name: 'flash_fired', type: 'INTEGER', description: '1 when the flash fired' },
  { name: 'location', type: 'TEXT', description: 'Latitude and longitude as "lat, lon"; NULL without coordinates' },
  { name: 'latitude', type: 'REAL', description: 'Signed decimal degrees' },
  { name: 'longitude', type: 'REAL', description: 'Signed decimal degrees' },
  { name: 'altitude', type: 'REAL', description: 'Meters above sea level' },
  { name: 'gps_direction', type: 'REAL', description: 'Direction the camera faced, in degrees' },
  { name: 'gps_direction_ref', type: 'TEXT', description: 'T for true north, M for magnetic' },
  { name: 'gps_speed', type: 'REAL', description: '' },
  { name: 'gps_timestamp', type: 'REAL', description: 'GPS time in milliseconds, UTC' },
  { name: 'title', type: 'TEXT', description: '' },
  { name: 'description', type: 'TEXT', description: 'Caption or description' },
  { name: 'creator', type: 'TEXT', description: 'Creator or artist' },
  { name: 'copyright', type: 'TEXT', description: '' },
  { name: 'credit', type: 'TEXT', description: '' },
  { name: 'rating', type: 'INTEGER', description: '' },
  { name: 'label', type: 'TEXT', description: 'Color label' },
  { name: 'keywords', type: 'TEXT', description: 'JSON array of keywords' },
  { name: 'city', type: 'TEXT', description: '' },
  { name: 'state', type: 'TEXT', description: 'State or province' },
  { name: 'country', type: 'TEXT', description: '' },
  { name: 'sublocation', type: 'TEXT', description: '' },
] as const;

type ImageFactField = typeof IMAGE_FACT_FIELDS[number];
export type ImageFacts = {
  [Field in ImageFactField as Field['name']]: (Field['type'] extends 'TEXT' ? string : number) | null;
};

export interface ImageIndexState extends OtherFileMetadata {
  metadata_status: ImageMetadataStatus;
  metadata_error: string | null;
  tag_count: number;
  bytes_read: number;
}

export interface IndexedImage extends ImageIndexState, ImageFacts {
  metadata: string | null;
}

export interface ImagePublication {
  rows: IndexedImage[];
  removed: string[];
}
