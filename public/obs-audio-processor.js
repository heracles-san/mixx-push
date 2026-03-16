// AudioWorklet processor — reçoit les chunks PCM du plugin OBS via IPC
// et les joue en continu avec un ring buffer pour absorber la latence réseau

class ObsAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(48000); // 1 seconde de buffer max
    this._writePos = 0;
    this._readPos  = 0;
    this._filled   = 0;

    this.port.onmessage = (e) => {
      const samples = new Float32Array(e.data);
      for (let i = 0; i < samples.length; i++) {
        this._ring[this._writePos] = samples[i];
        this._writePos = (this._writePos + 1) % this._ring.length;
        this._filled   = Math.min(this._filled + 1, this._ring.length);
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      if (this._filled > 0) {
        out[i] = this._ring[this._readPos];
        this._readPos = (this._readPos + 1) % this._ring.length;
        this._filled--;
      } else {
        out[i] = 0; // silence si buffer vide
      }
    }
    return true;
  }
}

registerProcessor("obs-audio-processor", ObsAudioProcessor);
