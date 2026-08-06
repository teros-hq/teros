/**
 * Ensures the "default" WAHA session exists and is started.
 * Called once at startup after WAHA is ready.
 *
 * Behaviour:
 *   - If session already exists (persisted from a previous run) → just start it.
 *     WAHA will auto-reconnect using the saved credentials (no re-linking needed).
 *   - If session does not exist → create it with GOWS storage config and start it.
 *     The session will enter SCAN_QR_CODE state (WAHA's "waiting to be linked" state);
 *     the user then links the device with request-pairing-code (pairing code is the
 *     only supported auth method — QR is not used).
 */
import { wahaFetch } from './api';

export async function ensureDefaultSession(): Promise<void> {
  const SESSION = 'default';
  try {
    const statusRes = await wahaFetch(`/sessions/${SESSION}`);

    if (statusRes.status === 404) {
      // Session does not exist yet → create with GOWS config
      console.error(`[mca.whatsapp] Session "${SESSION}" not found, creating with GOWS config...`);
      const createRes = await wahaFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: SESSION,
          config: {
            gows: {
              storage: {
                messages: true,
                groups: true,
                chats: true,
                labels: true,
              },
            },
          },
        }),
      });
      if (!createRes.ok) {
        const err = await createRes.text().catch(() => '');
        console.error(`[mca.whatsapp] Failed to create default session: ${createRes.status} ${err}`);
        return;
      }
      console.error(`[mca.whatsapp] Session "${SESSION}" created. Waiting for pairing-code linking (request-pairing-code).`);
      // Session is auto-started on creation by default
    } else if (statusRes.ok) {
      const sessionData = await statusRes.json();
      const status = sessionData?.status;
      console.error(`[mca.whatsapp] Session "${SESSION}" exists with status: ${status}`);

      if (status === 'STOPPED') {
        // Restart the stopped session — WAHA will restore credentials from .sessions/
        const startRes = await wahaFetch(`/sessions/${SESSION}/start`, { method: 'POST' });
        if (!startRes.ok) {
          const err = await startRes.text().catch(() => '');
          console.error(`[mca.whatsapp] Failed to start default session: ${startRes.status} ${err}`);
        } else {
          console.error(`[mca.whatsapp] Session "${SESSION}" started successfully.`);
        }
      } else if (status === 'FAILED') {
        // FAILED state: stop then start to recover
        console.error(`[mca.whatsapp] Session "${SESSION}" is FAILED, attempting recovery...`);
        await wahaFetch(`/sessions/${SESSION}/stop`, { method: 'POST' });
        await new Promise((r) => setTimeout(r, 1000));
        const startRes = await wahaFetch(`/sessions/${SESSION}/start`, { method: 'POST' });
        if (!startRes.ok) {
          const err = await startRes.text().catch(() => '');
          console.error(`[mca.whatsapp] Failed to recover default session: ${startRes.status} ${err}`);
        } else {
          console.error(`[mca.whatsapp] Session "${SESSION}" recovered successfully.`);
        }
      } else {
        // STARTING, SCAN_QR_CODE, WORKING — nothing to do
        console.error(`[mca.whatsapp] Session "${SESSION}" is already active (${status}), no action needed.`);
      }
    } else {
      console.error(`[mca.whatsapp] Unexpected status checking session "${SESSION}": ${statusRes.status}`);
    }
  } catch (err: any) {
    // Non-fatal: log and continue — the MCA server still starts
    console.error(`[mca.whatsapp] ensureDefaultSession error: ${err.message}`);
  }
}
