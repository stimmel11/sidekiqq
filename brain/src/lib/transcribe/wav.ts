/**
 * WAV (RIFF) header validation. The contract fixes the format: 16 kHz, mono, 16-bit PCM.
 * We validate rather than trust Content-Type so malformed uploads fail fast with a 4xx
 * instead of burning an STT request.
 */
export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioFormat: number;
  dataBytes: number;
  durationSeconds: number;
}

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

export function parseWav(buf: Uint8Array): WavInfo {
  if (buf.byteLength < 44) throw new WavError("Audio too short to be a WAV file");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off: number) => String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new WavError("Not a RIFF/WAVE file");

  let off = 12;
  let fmt: Omit<WavInfo, "dataBytes" | "durationSeconds"> | null = null;
  let dataBytes: number | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    let size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.byteLength) throw new WavError("Truncated fmt chunk");
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // Streaming writers sometimes leave size as 0 or 0xFFFFFFFF; trust the actual length.
      if (size === 0 || size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      dataBytes = size;
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new WavError("Missing fmt chunk");
  if (dataBytes === null) throw new WavError("Missing data chunk");
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  return { ...fmt, dataBytes, durationSeconds: bytesPerSec ? dataBytes / bytesPerSec : 0 };
}

export function assertContractWav(info: WavInfo): void {
  // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (still PCM for 16-bit)
  if (info.audioFormat !== 1 && info.audioFormat !== 0xfffe) throw new WavError("Audio must be PCM");
  if (info.sampleRate !== 16000) throw new WavError(`Expected 16000 Hz, got ${info.sampleRate}`);
  if (info.channels !== 1) throw new WavError(`Expected mono, got ${info.channels} channels`);
  if (info.bitsPerSample !== 16) throw new WavError(`Expected 16-bit samples, got ${info.bitsPerSample}`);
  if (info.dataBytes < 3200) throw new WavError("Audio shorter than 0.1 s");
}

/** Build a 16 kHz mono PCM16 WAV (used by tests and diagnostics). */
export function encodeWav(samples: Int16Array, sampleRate = 16000): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}
