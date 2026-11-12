/**
 * PCM Audio Worklet Processor
 *
 * Corre en un AudioWorkletGlobalScope dedicado (fuera del main thread).
 * Captura audio PCM 16-bit 16kHz mono y lo envía al main thread
 * para que sea transmitido por WebSocket al motor de voz.
 *
 * Formato de salida: Int16Array en little-endian.
 *
 * ── RMS mic gate (F5f) ──────────────────────────────────────────────────────
 * El gate de abajo es del motor LEGACY (ElevenLabs ConvAI): mientras el agente
 * habla, dropea chunks con RMS < UMBRAL como protección client-side de barge-in
 * contra eco. En el motor NATIVO ese pre-filtro DAÑA la experiencia: con cada
 * tts_chunk el contexto marca agentSpeaking=true, así que el mic del usuario
 * está gateado TODO el tiempo que el agente habla — y los ARRANQUES de frase
 * (primeras sílabas, onset suave, aún más atenuado por AEC/NS/AGC de
 * getUserMedia) caen bajo el umbral y se pierden enteros (chunk de 4096 samples
 * = 256ms con silencio+onset mezclado promedia bajo 0.02) → el STT pierde el
 * inicio de la palabra → "se me corta el micrófono".
 *
 * El motor nativo ya decide el barge-in en el SERVER (VAD de Deepgram:
 * onSpeechStart → handleBargeIn, autoritativo). Por eso el contexto manda
 * {type:'micGate', value:false} cuando voice.engine='native' y el PCM del
 * usuario fluye SIEMPRE — onsets intactos, el server decide.
 *
 * Default: gate ACTIVO. Si nunca llega el mensaje micGate (compatibilidad con
 * el path legacy y con cualquier cliente que no lo envíe), el worklet se
 * comporta EXACTAMENTE como antes — el legacy (fallback de prod) nunca se
 * rompe.
 *
 * ⚠️ TRADE-OFF ECO (documentado, decisión consciente): sin gate client-side,
 * con ALTAVOCES (no auriculares) el TTS del agente puede colarse en el mic y
 * disparar barge-ins falsos server-side. Mitigación existente: AEC del
 * navegador + VAD de Deepgram. Si aparecen falsos barge-ins en testing, se
 * tuneará el LADO SERVER (confianza del VAD / rampa de energía) — JAMÁS se
 * re-añadirá este gate client-side: se come los onsets de frase y ese bug es
 * peor que un falso barge-in ocasional.
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
    // F5f: gate ACTIVO por default — el path legacy (y cualquier cliente que
    // no envíe micGate) conserva el comportamiento byte-idéntico.
    this._micGateEnabled = true;

    // Recibir comandos del main thread
    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      if (type === 'mute') this._isMuted = value;
      if (type === 'agentSpeaking') this._agentSpeaking = value;
      // F5f: el contexto desactiva el gate con el motor nativo (el VAD
      // server-side es el dueño del barge-in). value=false → PCM fluye siempre.
      if (type === 'micGate') this._micGateEnabled = value;
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

    // Si el agente está hablando, solo enviar si el usuario intenta interrumpir.
    // F5f: solo con el gate ACTIVO (motor legacy). Con el motor nativo
    // (micGate=false) este bloque no aplica — el PCM fluye siempre y el
    // barge-in lo decide el VAD server-side.
    if (this._agentSpeaking && this._micGateEnabled) {
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
