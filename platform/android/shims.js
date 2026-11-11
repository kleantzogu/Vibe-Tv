/*
 * lib/ was written for Node and uses Buffer for bytes. The Android web bundle gets it from the
 * "buffer" package (scripts/build-android-web.js injects this file wherever Buffer is used).
 */
export { Buffer } from 'buffer/';
