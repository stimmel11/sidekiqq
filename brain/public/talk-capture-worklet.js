/*
 * SideKiqq Talk: mic capture worklet (docs/WEBAPP.md §6.1).
 * Posts a copy of channel 0 of every render quantum (Float32, at the AudioContext's own rate) to
 * the page, which resamples to 16 kHz and encodes the WAV (src/lib/talk/audio.ts). It produces
 * silence on its output and keeps nothing: audio lives only in the page until the upload.
 */
class SkqCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const copy = new Float32Array(input[0]);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor("skq-capture", SkqCaptureProcessor);
