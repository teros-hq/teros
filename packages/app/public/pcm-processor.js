/**
 * PCM Audio Worklet Processor
 *
 * Corre en un AudioWorkletGlobalScope dedicado (fuera del main thread).
 * Captura audio PCM 16-bit 16kHz mono y lo envía al main thread
 * para que sea transmitido por WebSocket a ElevenLabs.
 *
 * Formato de salida: Int16Array en little-endian (requerido por ElevenLabs).
 */

const BUFFER_SIZE = 4096; // muestras por chunk (~256ms a 16kHz)
const INTERRUPTION_RMS_THRESHOLD = 0.02;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._buffer = new Float32Array(BUFFER_SIZE);
    this._bufferIndex = 0;
    this._isMuted = false;
    this._agentSpeaking = false;

    // Recibir comandos del main thread
    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      if (type === 'mute') this._isMuted = value;
      if (type === 'agentSpeaking') this._agentSpeaking = value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0]; // Float32Array, mono

    for (let i = 0; i < samples.length; i++) {
      this._buffer[this._bufferIndex++] = samples[i];

      if (this._bufferIndex >= BUFFER_SIZE) {
        this._flush();
        this._bufferIndex = 0;
      }
    }

    return true; // keep processor alive
  }

  _flush() {
    if (this._isMuted) return;

    const chunk = this._buffer.slice(0, this._bufferIndex || BUFFER_SIZE);

    // Si el agente está hablando, solo enviar si el usuario intenta interrumpir
    if (this._agentSpeaking) {
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);
      if (rms < INTERRUPTION_RMS_THRESHOLD) return;
    }

    // Convertir Float32 [-1, 1] → Int16 PCM
    const int16 = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Transferir el buffer al main thread (zero-copy con Transferable)
    this.port.postMessage({ type: 'pcm', buffer: int16.buffer }, [int16.buffer]);
  }
}

registerProcessor('pcm-processor', PcmProcessor);
