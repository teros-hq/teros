/**
 * useScopeToggle — shared hook for toggling channel scope (personal ↔ shared).
 *
 * Extracted from ConversationsWindowContent (MUW-15) so that both the conversation
 * list and the open-chat window (ChatView/ChatHeader) can share the exact same
 * pre-publish scan → warning dialog → setScope flow (MUW-10).
 *
 * Usage:
 *   const {
 *     isScanning,           // true while prePublishScan is in flight
 *     showWarning,          // true → render <PrePublishWarningDialog>
 *     personalApps,         // apps detected by the scan (for the dialog)
 *     toggleScope,          // (channelId, currentScope) => void
 *     confirmPublishAnyway, // () => void  (called by the dialog's "Make shared anyway")
 *     cancelPublishWarning, // () => void  (called by the dialog's "Cancel")
 *   } = useScopeToggle({ onScopeChanged })
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getTerosClient } from '../../services/terosClientSingleton'
import { useToast } from '../../components/Toast'

export interface PersonalApp {
  appId: string
  name: string
}

export interface UseScopeToggleOptions {
  /** Called after scope was successfully changed (channelId, newScope). */
  onScopeChanged?: (channelId: string, newScope: 'personal' | 'shared') => void
}

export function useScopeToggle({ onScopeChanged }: UseScopeToggleOptions = {}) {
  const { t } = useTranslation()
  const toast = useToast()

  const [isScanning, setIsScanning] = useState(false)
  const [showWarning, setShowWarning] = useState(false)
  const [personalApps, setPersonalApps] = useState<PersonalApp[]>([])
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null)

  /**
   * Actually call setScope on the backend and fire the callback + toast.
   */
  const doSetScope = useCallback(
    async (channelId: string, newScope: 'personal' | 'shared') => {
      try {
        await getTerosClient().channel.setScope(channelId, newScope)
        onScopeChanged?.(channelId, newScope)
        toast.show(
          newScope === 'shared'
            ? t('conversations.scopeChangedShared')
            : t('conversations.scopeChangedPersonal'),
          { type: 'success' },
        )
      } catch (err) {
        console.error('[useScopeToggle] Error toggling scope:', err)
        toast.show(t('conversations.scopeError'), { type: 'error' })
      }
    },
    [onScopeChanged, t, toast],
  )

  /**
   * Toggle scope. When making a conversation shared, runs the pre-publish
   * scan first. If personal apps were used, shows the warning dialog and waits
   * for the user to confirm or cancel. When making it personal, proceeds directly.
   */
  const toggleScope = useCallback(
    async (channelId: string, currentScope: 'personal' | 'shared') => {
      const newScope = currentScope === 'shared' ? 'personal' : 'shared'

      if (newScope === 'shared') {
        setIsScanning(true)
        try {
          const scanResult = await getTerosClient().channel.prePublishScan(channelId)
          if (scanResult.hasWarning) {
            setPersonalApps(scanResult.personalApps)
            setPendingChannelId(channelId)
            setShowWarning(true)
            return // Wait for user decision in the warning dialog
          }
        } catch (err) {
          console.error('[useScopeToggle] Pre-publish scan failed, proceeding with standard toggle:', err)
          // If the scan fails, proceed with the standard toggle — don't block the user
        } finally {
          setIsScanning(false)
        }
      }

      await doSetScope(channelId, newScope)
    },
    [doSetScope],
  )

  /**
   * Called when the user clicks "Make shared anyway" in the warning dialog.
   */
  const confirmPublishAnyway = useCallback(async () => {
    setShowWarning(false)
    if (pendingChannelId) {
      await doSetScope(pendingChannelId, 'shared')
    }
    setPendingChannelId(null)
    setPersonalApps([])
  }, [pendingChannelId, doSetScope])

  /**
   * Called when the user clicks "Cancel" in the warning dialog (or closes it).
   */
  const cancelPublishWarning = useCallback(() => {
    setShowWarning(false)
    setPendingChannelId(null)
    setPersonalApps([])
  }, [])

  return {
    isScanning,
    showWarning,
    personalApps,
    toggleScope,
    confirmPublishAnyway,
    cancelPublishWarning,
  }
}
