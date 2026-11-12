/**
 * Utilidades puras de audio/waveform de InputComposer.web — extraídas del
 * componente (1791 LOC, acoplado a Web Audio API / recordrtc) para testear la
 * lógica DSP en aislamiento, sin arrastrar el grafo de UI. TER-461.
 *
 * Sin imports: funciones puras (Blob/AnalyserNode/Math son globales del runtime).
 */

/**
 * Cap del búfer rodante de muestras del waveform. Cualquier ancho renderizable
 * (≈140 barras en 700 px) queda cubierto; quien dibuja toma las últimas N.
 */
export const MAX_WAVEFORM_SAMPLES = 240;

/** Ensambla los chunks de grabación en un único Blob; null si no hay chunks. */
export function assembleBlob(chunks: Blob[]): Blob | null {
  if (!chunks.length) return null;
  return new Blob(chunks, { type: chunks[0].type || 'audio/mp4' });
}

/** Metering (dB, RMS) desde un AnalyserNode, recortado a [-60, 0]. */
export function calculateMetering(analyser: AnalyserNode): number {
  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  // RMS
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = (dataArray[i] - 128) / 128; // -1 to 1
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / dataArray.length);

  // dB (rango típico -60 a 0)
  const db = 20 * Math.log10(Math.max(rms, 0.0001));
  return Math.max(-60, Math.min(0, db));
}

/** Normaliza el metering [-50, 0] dB → [0.1, 1] (con clamp en ambos extremos). */
export function normalizeMetering(value: number): number {
  const METERING_MIN = -50;
  const METERING_MAX = 0;
  const normalized = (value - METERING_MIN) / (METERING_MAX - METERING_MIN);
  return Math.max(0.1, Math.min(1, normalized));
}

/** Formatea una duración en segundos como m:ss. */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Expande un array de muestras a `targetLength` por interpolación lineal. */
export function expandSamples(samples: number[], targetLength: number): number[] {
  if (samples.length === 0) return Array(targetLength).fill(0.3);
  if (samples.length >= targetLength) return samples.slice(0, targetLength);

  const expanded: number[] = [];
  const ratio = (samples.length - 1) / (targetLength - 1);

  for (let i = 0; i < targetLength; i++) {
    const srcIndex = i * ratio;
    const lowIndex = Math.floor(srcIndex);
    const highIndex = Math.min(lowIndex + 1, samples.length - 1);
    const fraction = srcIndex - lowIndex;
    const value = samples[lowIndex] * (1 - fraction) + samples[highIndex] * fraction;
    expanded.push(value);
  }

  return expanded;
}

/** Convierte un Blob de audio a base64 (para persistir en audioStore/localStorage). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decide si la página debe bloquear el unload (beforeunload) porque hay audio
 * en riesgo: grabando, pausado con blob en mano, o envío en vuelo.
 * `state` es el WebRecordingState del composer; `isSending` cubre el upload.
 */
export function shouldBlockUnload(
  state: 'idle' | 'recording' | 'paused',
  isSending: boolean,
): boolean {
  return state !== 'idle' || isSending;
}
