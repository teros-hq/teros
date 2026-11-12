/**
 * VoiceOrbOverlay — the persistent floating voice bubble (F5e) ⭐
 *
 * The orb leaves the chat: while a voice session is alive, the orb floats
 * over the WHOLE app — navigate anywhere, it stays present, audible,
 * breathing (the provider is already global: app/(workspace)/_layout.tsx).
 *
 *   - DRAG: web-native listeners (mousedown → document mousemove/mouseup).
 *     Grab the orb, drop it anywhere; the position persists (localStorage,
 *     teros_voice_orb_pos). A drag is a drag: a TAP (no movement, 5px slop)
 *     still opens the popover — the orb's existing control surface (mode ·
 *     mute · ¿qué has oído? · hang up). A completed drag swallows the
 *     trailing click so the drop does not open the popover.
 *   - CLOSE: the popover's "Colgar" — the same clean stopSession the chat
 *     used. No new close grammar: the orb already knows how to say goodbye.
 *   - IDENTITY: the PresenceOrb itself, untouched — same halo, same echo,
 *     same speaking ring, same breathing. This overlay only owns WHERE it
 *     lives, not WHAT it is.
 *
 * Silent grammar (commit 6b3dd07f4): nothing is added around the orb — no
 * panel, no border, no label, no shadow box. The orb IS the interface; the
 * overlay is just the sheet of glass it floats on.
 *
 * Native (non-web): no drag — the orb sits bottom-right (the same corner it
 * always lived in). Drag is a web affordance; the position store is web-only.
 *
 * Gated by voice.mode-ui — off = the overlay renders nothing (zero
 * regression: with the flag off the orb never mounts anywhere).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View as RNView, useWindowDimensions } from 'react-native';
import { useVoiceSession } from '../../contexts/VoiceSessionContext';
import { useNavbarStore } from '../../store/navbarStore';
import { useTilingStore } from '../../store/tilingStore';
import { useFeatureFlagsStore, getResolvedFlag } from '../../store/featureFlagsStore';
import { STORAGE_KEYS, storage } from '../../services/storage';
import { PresenceOrb } from './PresenceOrb';

// ─── Position store (web) ─────────────────────────────────────────────────────

/** Persisted orb position: { x, y } viewport coords of the orb's center. */
interface OrbPos {
  x: number;
  y: number;
}

const ORB_SIZE = 52; // matches PresenceOrb's web size
const EDGE = 8; // keep the orb fully on screen

/** Clamp so the orb never leaves the viewport (resize-safe on read). */
function clampPos(p: OrbPos): OrbPos {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  if (!w || !h) return p;
  return {
    x: Math.min(Math.max(p.x, EDGE + ORB_SIZE / 2), w - EDGE - ORB_SIZE / 2),
    y: Math.min(Math.max(p.y, EDGE + ORB_SIZE / 2), h - EDGE - ORB_SIZE / 2),
  };
}

/** Default: bottom-right — the corner the orb always lived in. */
function defaultPos(): OrbPos {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  return { x: w - EDGE - ORB_SIZE / 2 - 16, y: h - EDGE - ORB_SIZE / 2 - 24 };
}

// ─── The overlay ─────────────────────────────────────────────────────────────

const isWeb = Platform.OS === 'web';

/** Same breakpoint as Navbar.tsx — below it the sidebar (and its voice block) is not shown. */
const NAVBAR_BREAKPOINT = 768;

export function VoiceOrbOverlay() {
  const session = useVoiceSession();
  const { width } = useWindowDimensions();
  // Pablo (PoC 2026-10-31): on desktop the presence lives in the navbar
  // (VoicePresenceBlock, above the user row) — the floating orb only remains
  // where there is no sidebar (mobile widths, native).
  const navbarHostsOrb = isWeb && width >= NAVBAR_BREAKPOINT;
  const flags = useFeatureFlagsStore((s) => s.flags);
  const enabled =
    getResolvedFlag<boolean>({ flags }, 'voice.enabled') &&
    getResolvedFlag<boolean>({ flags }, 'voice.mode-ui');

  // The agent's face + name — the navbar cache (the orb never met a fetch).
  const activeAgentId = session.activeAgentId;
  const agent = useNavbarStore((s) =>
    activeAgentId ? s.agents.find((a) => a.agentId === activeAgentId) : undefined,
  );

  // Jump back to the conversation (Pablo, 2026-10-05): open (and focus) the
  // chat window of the channel this voice session lives in — the same door
  // DelegationRow uses. No-op when the session has no channel yet.
  // Preview routing (preview-tabs.md): a plain click reuses the desktop's
  // preview tab; only ctrl/cmd-click opens a separate tab.
  const openWindow = useTilingStore((s) => s.openWindow);
  const jumpToConversation = useCallback(() => {
    if (session.channelId) openWindow('chat', { channelId: session.channelId }, false);
  }, [openWindow, session.channelId]);

  // ── Position: persisted, clamped on every read ─────────────────────────────
  const [pos, setPos] = useState<OrbPos | null>(null); // null = default (bottom-right)
  const [, setIsDragging] = useState(false); // drives the grabbing cursor (web)

  // Hydrate the persisted position once (web only).
  useEffect(() => {
    if (!isWeb) return;
    storage.get<OrbPos>(STORAGE_KEYS.VOICE_ORB_POS).then((p) => {
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        setPos(clampPos(p));
      }
    });
  }, []);

  const persistPos = useCallback((p: OrbPos) => {
    storage.set(STORAGE_KEYS.VOICE_ORB_POS, p).catch(() => {});
  }, []);

  // ── Drag: web-native listeners ────────────────────────────────────────────
  // A drag moves the orb live; a TAP (no movement) must still open the
  // popover — so the gesture is only claimed after real movement (5px slop),
  // and the press handlers never call preventDefault on the trigger itself
  // (the Pressable inside PresenceOrb owns the tap).
  //
  // Implementation: listeners on the WRAPPER element (mousedown → document
  // mousemove/mouseup). React Native's View pointer props type
  // NativeSyntheticEvent (no clientX) — the web drag needs the DOM event.
  // A completed drag swallows the trailing click (a capture-phase stop) so
  // the popover does not open on drop.
  const wrapperRef = useRef<HTMLElement | null>(null);

  // The drag reads the LIVE position (posRef) — the effect above only arms
  // once; a stale closure would drag from the pre-hydration default.
  const posRef = useRef<OrbPos | null>(null);
  posRef.current = pos;

  useEffect(() => {
    if (!isWeb) return;
    const el = wrapperRef.current;
    if (!el) return;

    const onDown = (e: MouseEvent) => {
      const origin = posRef.current ?? defaultPos();
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 5) return; // slop: still a tap
        moved = true;
        setIsDragging(true);
        el.style.cursor = 'grabbing'; // quiet affordance while dragging
        setPos(clampPos({ x: origin.x + dx, y: origin.y + dy }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        setIsDragging(false);
        el.style.cursor = '';
        if (moved) {
          // Drop: persist the resting position.
          persistPos(clampPos(posRef.current ?? defaultPos()));
          // The drop must not also open the popover — swallow the click
          // that follows the mouseup (capture phase, once).
          const swallow = (click: MouseEvent) => {
            click.stopPropagation();
            click.preventDefault();
          };
          document.addEventListener('click', swallow, { capture: true, once: true });
          // Safety: unswallow after the click cycle even if none came.
          setTimeout(() => document.removeEventListener('click', swallow, true), 50);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('mousedown', onDown);
    };
  }, [persistPos]);

  // ── Render ─────────────────────────────────────────────────────────────────
  // Nothing while there is no session — the overlay is INVISIBLE until the
  // voice is alive. Off/error presence still renders (error badge is state).
  if (!enabled || navbarHostsOrb || session.presence === 'off') return null;

  const style: any = isWeb
    ? {
        // 'fixed' is web-only — the codebase's convention for web overlays
        // (Navbar uses the same cast). Native uses absolute below.
        position: 'fixed',
        left: (pos ?? defaultPos()).x - ORB_SIZE / 2,
        top: (pos ?? defaultPos()).y - ORB_SIZE / 2,
        zIndex: 90, // above the tiling canvas, below modals/sheets
      }
    : {
        // Native: the corner it always lived in — no drag, no store.
        position: 'absolute' as const,
        right: 16,
        bottom: 24,
      };

  return (
    <RNView
      ref={wrapperRef as never}
      style={style}
      // The wrapper must not eat the tap — the orb's Pressable needs it.
      pointerEvents="box-none"
      testID="voice-orb-overlay"
    >
      <PresenceOrb
        presence={session.presence}
        mode={session.mode}
        activity={session.activity}
        audioLevel={session.audioLevel}
        agentAvatarUrl={agent?.avatarUrl}
        agentName={agent?.name}
        lastHeard={session.lastHeard}
        workerName={session.workerName}
        reconnectAttempt={session.reconnectAttempt}
        onSetMode={session.setMode}
        onToggleMute={session.toggleMute}
        isMuted={session.isMuted}
        onJumpToConversation={jumpToConversation}
        onDisconnect={session.stopSession}
      />
    </RNView>
  );
}
