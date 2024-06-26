import { Conf } from '@/config.ts';

import { ipfsUploader } from '@/uploaders/ipfs.ts';
import { localUploader } from '@/uploaders/local.ts';
import { s3Uploader } from '@/uploaders/s3.ts';

import type { Uploader } from './types.ts';

/** Meta-uploader determined from configuration. */
const configUploader: Uploader = {
  upload(file, opts) {
    return uploader().upload(file, opts);
  },
  delete(id, opts) {
    return uploader().delete(id, opts);
  },
};

/** Get the uploader module based on configuration. */
function uploader() {
  switch (Conf.uploader) {
    case 's3':
      return s3Uploader;
    case 'ipfs':
      return ipfsUploader;
    case 'local':
      return localUploader;
    default:
      throw new Error('No `DITTO_UPLOADER` configured. Uploads are disabled.');
  }
}

export { configUploader };
