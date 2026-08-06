import React, { useState, useCallback } from 'react'
import { Platform } from 'react-native'
import { Button, Input, Text, XStack, YStack, Sheet } from 'tamagui'
import { ThumbsUp, ThumbsDown, Copy, Flag } from '@tamagui/lucide-icons'
import { getTerosClient } from '../services/terosClientSingleton'
import type { MessageFeedbackReason } from '../services/FeedbackApi'
import { useToast } from './Toast'
import { t } from '../lib/i18n'
import { useColors } from './mca/primitives/useColors'
import { AppSpinner } from './ui/AppSpinner'

interface MessageFeedbackProps {
  messageId: string
  channelId: string
  messageText: string
  currentRating?: 'up' | 'down'
}

const REASONS: MessageFeedbackReason[] = [
  'inaccurate',
  'incomplete',
  'not_helpful',
  'wrong_tone',
  'did_not_follow_instructions',
  'other',
]

export function MessageFeedback({ messageId, channelId, messageText, currentRating }: MessageFeedbackProps): React.ReactElement {
  const c = useColors()
  const toast = useToast()
  const [selectedRating, setSelectedRating] = useState<'up' | 'down' | undefined>(currentRating)
  const [showReasons, setShowReasons] = useState(false)
  const [selectedReasons, setSelectedReasons] = useState<MessageFeedbackReason[]>([])
  const [comment, setComment] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [reportDescription, setReportDescription] = useState('')
  const [isReporting, setIsReporting] = useState(false)

  const submitFeedback = useCallback(
    async (rating: 'up' | 'down', reasons?: MessageFeedbackReason[], feedbackComment?: string) => {
      setIsSubmitting(true)
      try {
        await getTerosClient().feedback.submitMessageFeedback({
          messageId,
          channelId,
          rating,
          reasons,
          comment: feedbackComment,
        })
        setSelectedRating(rating)
        if (rating === 'up') {
          toast.success(t('feedback.thankYou'))
        }
      } catch (err: any) {
        console.error('[MessageFeedback] Failed to submit feedback:', err)
        toast.error(t('feedback.submitError'), err?.message || t('feedback.tryAgain'))
      } finally {
        setIsSubmitting(false)
      }
    },
    [messageId, channelId, t, toast],
  )

  const handleThumbsUp = useCallback(() => {
    if (selectedRating === 'up' || isSubmitting) return
    setShowReasons(false)
    setSelectedReasons([])
    setComment('')
    submitFeedback('up')
  }, [selectedRating, isSubmitting, submitFeedback])

  const handleThumbsDown = useCallback(() => {
    if (selectedRating === 'down' || isSubmitting) return
    setShowReasons(true)
    setSelectedReasons([])
    setComment('')
    submitFeedback('down')
  }, [selectedRating, isSubmitting, submitFeedback])

  const handleSubmitDownvoteDetails = useCallback(() => {
    submitFeedback('down', selectedReasons, comment.trim() || undefined)
    setShowReasons(false)
  }, [submitFeedback, selectedReasons, comment])

  const toggleReason = useCallback((reason: MessageFeedbackReason) => {
    setSelectedReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    )
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(messageText)
      }
      await getTerosClient().feedback.submitMessageAction({
        messageId,
        channelId,
        action: 'copy',
      })
      toast.success(t('feedback.copied'))
    } catch (err: any) {
      console.error('[MessageFeedback] Failed to copy or log copy action:', err)
      toast.error(t('feedback.copyError'), err?.message || t('feedback.tryAgain'))
    }
  }, [messageId, channelId, messageText, t, toast])

  const handleReport = useCallback(async () => {
    const description = reportDescription.trim()
    if (!description) return
    setIsReporting(true)
    try {
      await getTerosClient().feedback.submitMessageAction({
        messageId,
        channelId,
        action: 'report',
        description,
      })
      setReportModalOpen(false)
      setReportDescription('')
      toast.success(t('feedback.reportSent'))
    } catch (err: any) {
      console.error('[MessageFeedback] Failed to submit report:', err)
      toast.error(t('feedback.reportError'), err?.message || t('feedback.tryAgain'))
    } finally {
      setIsReporting(false)
    }
  }, [messageId, channelId, reportDescription, t, toast])

  return (
    <YStack gap="$2" alignSelf="flex-start" width="100%">
      <XStack alignItems="center" gap="$2">
        {isSubmitting ? (
          <XStack alignItems="center" gap="$2" padding="$2">
            <AppSpinner size="sm" variant="onDark" />
            <Text fontSize="$2" color={c.text3}>
              {t('feedback.sending')}
            </Text>
          </XStack>
        ) : (
          <>
            <Button
              size="$2"
              chromeless
              disabled={isSubmitting}
              onPress={handleThumbsUp}
              icon={ThumbsUp}
              color={selectedRating === 'up' ? '$green10' : c.text3}
              aria-label={t('feedback.thumbsUp')}
            />
            <Button
              size="$2"
              chromeless
              disabled={isSubmitting}
              onPress={handleThumbsDown}
              icon={ThumbsDown}
              color={selectedRating === 'down' ? '$red10' : c.text3}
              aria-label={t('feedback.thumbsDown')}
            />
            <Button
              size="$2"
              chromeless
              onPress={handleCopy}
              icon={Copy}
              color={c.text3}
              aria-label={t('feedback.copy')}
            />
            <Button
              size="$2"
              chromeless
              onPress={() => setReportModalOpen(true)}
              icon={Flag}
              color={c.text3}
              aria-label={t('feedback.report')}
            />
          </>
        )}
      </XStack>

      {showReasons && selectedRating !== 'up' && (
        <YStack
          gap="$2"
          padding="$3"
          borderRadius="$4"
          backgroundColor={c.bgInner}
          width="100%"
        >
          <Text fontSize="$3" color={c.text2}>
            {t('feedback.why')}
          </Text>
          <XStack flexWrap="wrap" gap="$2">
            {REASONS.map((reason) => (
              <Button
                key={reason}
                size="$1"
                borderRadius="$6"
                backgroundColor={selectedReasons.includes(reason) ? c.badges.info.bg : c.bgInner}
                color={selectedReasons.includes(reason) ? c.badges.info.text : c.text2}
                borderWidth={selectedReasons.includes(reason) ? 1 : 0}
                borderColor={c.badges.info.border}
                onPress={() => toggleReason(reason)}
                aria-label={t(`feedback.reasons.${reason}`)}
              >
                {t(`feedback.reasons.${reason}`)}
              </Button>
            ))}
          </XStack>
          <Input
            size="$3"
            placeholder={t('feedback.commentPlaceholder')}
            value={comment}
            onChangeText={setComment}
            multiline
            numberOfLines={3}
            maxLength={2000}
            color={c.text}
            placeholderTextColor={c.text3}
            backgroundColor={c.bgInner}
            borderColor={c.border}
          />
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              size="$2"
              chromeless
              onPress={() => setShowReasons(false)}
              color={c.text2}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="$2"
              disabled={isSubmitting}
              onPress={handleSubmitDownvoteDetails}
              backgroundColor={c.border}
              color={c.text}
              icon={isSubmitting ? () => <AppSpinner size="xs" variant="onDark" /> : undefined}
            >
              {isSubmitting ? t('feedback.sending') : t('feedback.submit')}
            </Button>
          </XStack>
        </YStack>
      )}

      <Sheet
        modal
        open={reportModalOpen}
        onOpenChange={setReportModalOpen}
        snapPoints={[40]}
        dismissOnSnapToBottom
      >
        <Sheet.Frame padding="$4" gap="$3">
          <Sheet.Handle />
          <Text fontSize="$4" color={c.text}>
            {t('feedback.report')}
          </Text>
          <Text fontSize="$2" color={c.text3}>
            {t('feedback.reportDescriptionLabel')}
          </Text>
          <Input
            size="$3"
            placeholder={t('feedback.reportPlaceholder')}
            value={reportDescription}
            onChangeText={setReportDescription}
            multiline
            numberOfLines={4}
            color={c.text}
            placeholderTextColor={c.text3}
            backgroundColor={c.bgInner}
            borderColor={c.border}
          />
          <XStack gap="$2" justifyContent="flex-end">
            <Button
              size="$3"
              chromeless
              onPress={() => setReportModalOpen(false)}
              color={c.text2}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="$3"
              disabled={isReporting || !reportDescription.trim()}
              onPress={handleReport}
              backgroundColor={c.border}
              color={c.text}
              icon={isReporting ? () => <AppSpinner size="xs" variant="onDark" /> : undefined}
            >
              {isReporting ? t('feedback.sending') : t('feedback.submitReport')}
            </Button>
          </XStack>
        </Sheet.Frame>
      </Sheet>
    </YStack>
  )
}
