/**
 * useWhatsNewModal — Hook that manages the "What's New" changelog modal
 *
 * Responsibilities:
 * - On app load (when profile is synced), check if there are unseen changelog entries
 * - If yes, auto-show the modal
 * - On dismiss, call profile.markChangelogSeen to persist the last seen entry ID
 * - Update the auth store so the modal doesn't reappear until new entries are added
 * - Expose `showWhatsNew()` for manual re-opening from the Navbar
 *
 * Usage:
 *   const { isModalVisible, modalEntries, isManualReopen, handleDismiss, showWhatsNew } = useWhatsNewModal()
 *   {isModalVisible && <WhatsNewModal entries={modalEntries} onDismiss={handleDismiss} isManualReopen={isManualReopen} />}
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { getUnseenChangelogEntries, getAllChangelogEntries } from '../changelog'
import { useAuthStore } from '../store/authStore'
import { getTerosClient } from '../services/terosClientSingleton'

export interface UseWhatsNewModalResult {
  /** Whether the modal is currently visible */
  isModalVisible: boolean
  /** Entries to display in the carousel */
  modalEntries: ReturnType<typeof getAllChangelogEntries>
  /** Whether this is a manual re-open (affects button text) */
  isManualReopen: boolean
  /** Dismiss the modal and persist the last seen entry ID */
  handleDismiss: (lastSeenEntryId: string) => void
  /** Manually open the modal (from Navbar entry point) */
  showWhatsNew: () => void
}

export function useWhatsNewModal(): UseWhatsNewModalResult {
  const [isModalVisible, setIsModalVisible] = useState(false)
  const [modalEntries, setModalEntries] = useState<ReturnType<typeof getAllChangelogEntries>>([])
  const [isManualReopen, setIsManualReopen] = useState(false)

  const user = useAuthStore((s) => s.user)
  const isProfileSynced = useAuthStore((s) => s.isProfileSynced)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  // Track whether we've already auto-checked on this mount
  const autoCheckedRef = useRef(false)

  // Auto-show on app load when profile is synced and there are unseen entries
  useEffect(() => {
    if (autoCheckedRef.current) return
    if (!isProfileSynced || !user) return

    autoCheckedRef.current = true

    const unseen = getUnseenChangelogEntries(user.lastChangelogSeen)
    if (unseen.length > 0) {
      setModalEntries(unseen)
      setIsManualReopen(false)
      setIsModalVisible(true)
    }
  }, [isProfileSynced, user])

  const handleDismiss = useCallback(
    async (lastSeenEntryId: string) => {
      setIsModalVisible(false)

      // Optimistically update the auth store so the modal doesn't reappear
      updateProfile({ lastChangelogSeen: lastSeenEntryId })

      // Persist to backend (fire-and-forget — errors logged but not shown to user)
      try {
        const client = getTerosClient()
        await client.profile.markChangelogSeen(lastSeenEntryId)
      } catch (err) {
        console.warn('[useWhatsNewModal] Failed to mark changelog seen:', err)
      }
    },
    [updateProfile],
  )

  const showWhatsNew = useCallback(() => {
    // Manual re-open shows ALL entries (not just unseen)
    const allEntries = getAllChangelogEntries()
    if (allEntries.length === 0) return

    setModalEntries(allEntries)
    setIsManualReopen(true)
    setIsModalVisible(true)
  }, [])

  return {
    isModalVisible,
    modalEntries,
    isManualReopen,
    handleDismiss,
    showWhatsNew,
  }
}
