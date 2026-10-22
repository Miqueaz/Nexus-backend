import { Buffer } from 'node:buffer';
import { ensure } from '../../core/errors.js';
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const formats = {
  pdf: ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
  png: ['image/png', (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'],
  jpg: ['image/jpeg', (b) => b[0] === 255 && b[1] === 216 && b[2] === 255],
  jpeg: ['image/jpeg', (b) => b[0] === 255 && b[1] === 216 && b[2] === 255],
  webp: [
    'image/webp',
    (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  ],
  gif: ['image/gif', (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())],
  doc: ['application/msword', (b) => b.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    (b) => b.subarray(0, 4).toString('hex') === '504b0304',
  ],
};
export function validateFile(input) {
  const bytes = Buffer.from(input.data, 'base64');
  ensure(
    bytes.length > 0 && bytes.length <= MAX_FILE_BYTES,
    422,
    'FILE_SIZE',
    'El archivo admite hasta 4 MB',
  );
  ensure(bytes.toString('base64') === input.data, 422, 'FILE_INVALID', 'El archivo no es válido');
  const format = formats[input.name.split('.').at(-1).toLowerCase()];
  ensure(
    format && format[1](bytes),
    422,
    'FILE_TYPE',
    'Usa Word (.doc o .docx), PDF o imágenes PNG, JPG, GIF o WebP válidas',
  );
  return { name: input.name, mime: format[0], size: bytes.length, data: input.data };
}
export function docMetadata(row) {
  const { blocks, elements, board, attachment, ...meta } = row;
  return attachment
    ? {
        ...meta,
        attachment: { name: attachment.name, mime: attachment.mime, size: attachment.size },
      }
    : meta;
}
