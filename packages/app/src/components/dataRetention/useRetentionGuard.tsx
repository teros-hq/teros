/**
 * useRetentionGuard — gates a selection behind the RetentionConfirmModal when
 * the chosen model/provider is 🔴 (trains on your data / opaque) and the user
 * hasn't already acknowledged it.
 *
 * Usage:
 *   const { guard, modalProps } = useRetentionGuard()
 *   ...
 *   onPress={() => guard(info, modelId, modelName, () => applySelection())}
 *   ...
 *   <RetentionConfirmModal {...modalProps} />
 *
 * The dialog fires for any non-ZDR posture (🟡 retains and 🔴 trains), each
 * carrying its own reason via the provider's notice text. For 🟢 ZDR, or an
 * already-acknowledged key, `proceed` runs immediately. The acknowledgement is
 * remembered per key (modelId / provider type) across sessions via the
 * retention-ack store.
 */

import { useCallback, useState } from 'react'
import type { RetentionInfo } from '@teros/shared'
import { useRetentionAckStore } from '../../store/retentionAckStore'

interface PendingSelection {
  info: RetentionInfo
  /** Acknowledgement key, composed with the tier (see guard). */
  ackKey: string
  name?: string
  proceed: () => void
}

export function useRetentionGuard() {
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const isAcked = useRetentionAckStore((s) => s.isAcked)
  const ack = useRetentionAckStore((s) => s.ack)

  const guard = useCallback(
    (
      info: RetentionInfo | null | undefined,
      key: string,
      name: string | undefined,
      proceed: () => void,
    ) => {
      // Compose the ack key with the tier so a posture that WORSENS for the same
      // model/provider (e.g. zhipu z.ai 🟡 → useChina 🔴, or a future
      // reclassification) re-prompts instead of riding a stale acknowledgement.
      const ackKey = info ? `${key}:${info.tier}` : key
      if (info && info.tier !== 'zdr' && !isAcked(ackKey)) {
        setPending({ info, ackKey, name, proceed })
      } else {
        proceed()
      }
    },
    [isAcked],
  )

  const modalProps = {
    open: pending !== null,
    info: pending?.info ?? null,
    modelName: pending?.name,
    onConfirm: () => {
      if (pending) {
        ack(pending.ackKey)
        pending.proceed()
      }
      setPending(null)
    },
    onCancel: () => setPending(null),
  }

  return { guard, modalProps }
}
