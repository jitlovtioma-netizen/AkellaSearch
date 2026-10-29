/**
 * In-browser format conversion: png/jpg/bmp/tiff → webp, mp3/wav/flac/m4a → ogg (Opus).
 * Images use the browser's own WebP encoder; audio is decoded with Web Audio and encoded
 * by the bundled opus-recorder worker, faster than real time.
 */

const IMAGE_FROM = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"];
const AUDIO_FROM = ["mp3", "wav", "flac", "m4a", "aac"];
const MAX_SIDE = 16384;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
const CHUNK = 4096;

let workerUrl = null;

/** Set the URL of the Opus encoder worker (resolved by the module at startup). */
export function setEncoderUrl(url) {
  workerUrl = url;
}

function ext(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function stem(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

/** What a file would be converted to, or null if it stays as is. */
export function conversionTarget(name, { images = true, audio = true } = {}) {
  const e = ext(name);
  if (images && IMAGE_FROM.includes(e)) return "webp";
  if (audio && AUDIO_FROM.includes(e)) return "ogg";
  return null;
}

export function convertedName(name, target) {
  return `${stem(name)}.${target}`;
}

/** Encode an image as WebP. */
export async function toWebp(blob, quality = 0.85) {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (width > MAX_SIDE || height > MAX_SIDE) throw new Error(`Image too large for WebP (${width}×${height}, max ${MAX_SIDE})`);
    let out;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      out = await canvas.convertToBlob({ type: "image/webp", quality });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      out = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", quality));
    }
    // Browsers without a WebP encoder (Safari) silently return PNG.
    if (!out || out.type !== "image/webp") throw new Error("This browser cannot encode WebP");
    return out;
  } finally {
    bitmap.close?.();
  }
}

/** Encode audio as Ogg Opus. */
export async function toOgg(blob, { bitRate = 128000 } = {}) {
  if (!workerUrl) throw new Error("Opus encoder is not available");
  if (blob.size > MAX_AUDIO_BYTES) throw new Error("Audio file too large to convert in the browser");
  const decoder = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 48000 });
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  const channels = Math.min(2, audio.numberOfChannels);
  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    const pages = [];
    worker.onerror = err => {
      worker.terminate();
      reject(new Error(err.message ?? "Opus encoder failed"));
    };
    worker.onmessage = ({ data: msg }) => {
      if (msg?.page) pages.push(msg.page);
      else if (msg?.message === "ready") {
        worker.postMessage({ command: "getHeaderPages" });
        for (let i = 0; i < audio.length; i += CHUNK) {
          worker.postMessage({ command: "encode", buffers: data.map(d => d.slice(i, i + CHUNK)) });
        }
        worker.postMessage({ command: "done" });
      } else if (msg?.message === "done") {
        worker.terminate();
        resolve(new Blob(pages, { type: "audio/ogg" }));
      }
    };
    worker.postMessage({
      command: "init",
      encoderSampleRate: 48000,
      originalSampleRate: 48000,
      numberOfChannels: channels,
      encoderApplication: 2049,
      encoderBitRate: bitRate,
      encoderComplexity: 5
    });
  });
}

/**
 * Convert a file if it is one of the source formats.
 * @returns {Promise<{blob: Blob, name: string, converted: boolean, error?: Error}>}
 *   On failure the original file is returned unchanged, with the error.
 */
export async function maybeConvert(blob, name, options = {}) {
  const target = conversionTarget(name, options);
  if (!target) return { blob, name, converted: false };
  try {
    const out = target === "webp" ? await toWebp(blob, options.quality) : await toOgg(blob, options);
    return { blob: out, name: convertedName(name, target), converted: true };
  } catch (error) {
    console.warn(`Conversion of ${name} skipped:`, error);
    return { blob, name, converted: false, error };
  }
}
