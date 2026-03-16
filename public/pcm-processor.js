// pcm-processor.js — AudioWorklet qui injecte des chunks PCM dans le graphe audio
// Reçoit des Float32Array via port.postMessage et les joue en temps réel

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue  = [];
    this._offset = 0;

    this.port.onmessage = (e) => {
      // e.data = Float32Array (mono ou interleaved stereo)
      this._queue.push(e.data);
      // Évite que la queue grossisse indéfiniment si le renderer est trop lent
      if (this._queue.length > 50) {
        this._queue = this._queue.slice(-10);
        this._offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out    = outputs[0][0]; // canal gauche
    const needed = out.length;    // 128 samples
    let   filled = 0;

    while (filled < needed && this._queue.length > 0) {
      const chunk     = this._queue[0];
      const available = chunk.length - this._offset;
      const take      = Math.min(available, needed - filled);

      out.set(chunk.subarray(this._offset, this._offset + take), filled);
      filled        += take;
      this._offset  += take;

      if (this._offset >= chunk.length) {
        this._queue.shift();
        this._offset = 0;
      }
    }

    // Copie le canal gauche sur le canal droit si disponible (sortie stéréo)
    if (outputs[0].length >= 2) {
      outputs[0][1].set(out);
    }

    return true; // keep alive
  }
}

registerProcessor("pcm-processor", PcmProcessor);
