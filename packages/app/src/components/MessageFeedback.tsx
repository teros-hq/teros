import React, { useState, useCallback } from "react"
import { Platform, View } from "react-native"
import { Sheet } from "tamagui"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../services/terosClientSingleton"
import type { MessageFeedbackReason } from "../services/FeedbackApi"
import { useToast } from "./Toast"
import { useColors } from "./mca/primitives/useColors"
import { AppSpinner } from "./ui/AppSpinner"
import { Btn, ChipBtn, Field, IconBtn, T } from "./ui/ds"

interface MessageFeedbackProps {
  messageId: string
  channelId: string
  messageText: string
  currentRating?: "up" | "down"
  /** Whether the current user is the channel owner (shows Redact button, REQ-4) */
  isChannelOwner?: boolean
  /** Callback to toggle redaction on a message (owner only, AC-5) */
  onToggleRedaction?: (messageId: string, redacted: boolean) => void
}

const REASONS: MessageFeedbackReason[] = [
  "inaccurate",
  "incomplete",
  "not_helpful",
  "wrong_tone",
  "did_not_follow_instructions",
  "other",
]

/**
 * `.msg-actions` — the quiet action row under an agent reply: thumbs up /
 * down, copy, flag (+ redact for owners) as small plain IconBtns, 55%
 * opacity at rest, full on hover / focus.
 */
function MessageFeedbackInner({
  messageId,
  channelId,
  messageText,
  currentRating,
  isChannelOwner,
  onToggleRedaction,
}: MessageFeedbackProps): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()
  const toast = useToast()
  const [selectedRating, setSelectedRating] = useState<"up" | "down" | undefined>(currentRating)
  const [showReasons, setShowReasons] = useState(false)
  const [selectedReasons, setSelectedReasons] = useState<MessageFeedbackReason[]>([])
  const [comment, setComment] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [reportDescription, setReportDescription] = useState("")
  const [isReporting, setIsReporting] = useState(false)
  const [hover, setHover] = useState(false)

  const submitFeedback = useCallback(
    async (rating: "up" | "down", reasons?: MessageFeedbackReason[], feedbackComment?: string) => {
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
        if (rating === "up") {
          toast.success(t("feedback.thankYou"))
        }
      } catch (err: any) {
        console.error("[MessageFeedback] Failed to submit feedback:", err)
        toast.error(t("feedback.submitError"), err?.message || t("feedback.tryAgain"))
      } finally {
        setIsSubmitting(false)
      }
    },
    [messageId, channelId, t, toast],
  )

  const handleThumbsUp = useCallback(() => {
    if (selectedRating === "up" || isSubmitting) return
    setShowReasons(false)
    setSelectedReasons([])
    setComment("")
    submitFeedback("up")
  }, [selectedRating, isSubmitting, submitFeedback])

  const handleThumbsDown = useCallback(() => {
    if (selectedRating === "down" || isSubmitting) return
    setShowReasons(true)
    setSelectedReasons([])
    setComment("")
    submitFeedback("down")
  }, [selectedRating, isSubmitting, submitFeedback])

  const handleSubmitDownvoteDetails = useCallback(() => {
    submitFeedback("down", selectedReasons, comment.trim() || undefined)
    setShowReasons(false)
  }, [submitFeedback, selectedReasons, comment])

  const toggleReason = useCallback((reason: MessageFeedbackReason) => {
    setSelectedReasons((prev) =>
      prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason],
    )
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(messageText)
      }
      await getTerosClient().feedback.submitMessageAction({
        messageId,
        channelId,
        action: "copy",
      })
      toast.success(t("feedback.copied"))
    } catch (err: any) {
      console.error("[MessageFeedback] Failed to copy or log copy action:", err)
      toast.error(t("feedback.copyError"), err?.message || t("feedback.tryAgain"))
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
        action: "report",
        description,
      })
      setReportModalOpen(false)
      setReportDescription("")
      toast.success(t("feedback.reportSent"))
    } catch (err: any) {
      console.error("[MessageFeedback] Failed to submit report:", err)
      toast.error(t("feedback.reportError"), err?.message || t("feedback.tryAgain"))
    } finally {
      setIsReporting(false)
    }
  }, [messageId, channelId, reportDescription, t, toast])

  const keep = showReasons || hover || reportModalOpen

  return (
    <View style={{ alignSelf: "flex-start", width: "100%", gap: 8 }}>
      <View
        {...(Platform.OS === "web"
          ? ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)
          : {})}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 2,
            marginTop: 12,
            marginLeft: -6,
            opacity: keep ? 1 : 0.55,
          },
          Platform.OS === "web" ? ({ transition: "opacity 0.25s" } as any) : null,
        ]}
      >
        {isSubmitting ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 6 }}
          >
            <AppSpinner size="sm" />
            <T step="12" tone="text3">
              {t("feedback.sending")}
            </T>
          </View>
        ) : (
          <>
            <IconBtn
              icon="thumbs-up"
              plain
              sm
              on={selectedRating === "up"}
              disabled={isSubmitting}
              onPress={handleThumbsUp}
              title={t("feedback.thumbsUp")}
              aria-label={t("feedback.thumbsUp")}
            />
            <IconBtn
              icon="thumbs-down"
              plain
              sm
              on={selectedRating === "down"}
              disabled={isSubmitting}
              onPress={handleThumbsDown}
              title={t("feedback.thumbsDown")}
              aria-label={t("feedback.thumbsDown")}
            />
            <IconBtn
              icon="copy"
              plain
              sm
              onPress={handleCopy}
              title={t("feedback.copy")}
              aria-label={t("feedback.copy")}
            />
            <IconBtn
              icon="flag"
              plain
              sm
              onPress={() => setReportModalOpen(true)}
              title={t("feedback.report")}
              aria-label={t("feedback.report")}
            />
            {isChannelOwner && onToggleRedaction && (
              <IconBtn
                icon="shield"
                plain
                sm
                onPress={() => onToggleRedaction(messageId, true)}
                title={t("conversations.redacted.redact")}
                aria-label={t("conversations.redacted.redact")}
              />
            )}
          </>
        )}
      </View>

      {showReasons && selectedRating !== "up" && (
        <View
          style={[
            {
              gap: 12,
              padding: 16,
              borderRadius: 16,
              backgroundColor: c.bgStep,
              width: "100%",
              maxWidth: 560,
            },
            Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
          ]}
        >
          <T step="sm" tone="text2">
            {t("feedback.why")}
          </T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {REASONS.map((reason) => (
              <ChipBtn
                key={reason}
                on={selectedReasons.includes(reason)}
                onPress={() => toggleReason(reason)}
                aria-label={t(`feedback.reasons.${reason}`)}
              >
                {t(`feedback.reasons.${reason}`)}
              </ChipBtn>
            ))}
          </View>
          <Field
            area
            minHeight={72}
            placeholder={t("feedback.commentPlaceholder")}
            value={comment}
            onChangeText={setComment}
            maxLength={2000}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" size="sm" onPress={() => setShowReasons(false)}>
              {t("common.cancel")}
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              disabled={isSubmitting}
              loading={isSubmitting}
              onPress={handleSubmitDownvoteDetails}
            >
              {isSubmitting ? t("feedback.sending") : t("feedback.submit")}
            </Btn>
          </View>
        </View>
      )}

      {/* Report dialog — conditionally rendered so only ONE Sheet exists in the
          DOM at a time (when open). Previously the Sheet was always mounted per-
          message, causing 8+ duplicate dialog instances in the DOM even when
          closed. Now: 0 nodes when closed, 1 node when open. */}
      {reportModalOpen && (
        <Sheet
          modal
          open={reportModalOpen}
          onOpenChange={setReportModalOpen}
          snapPoints={[40]}
          dismissOnSnapToBottom
        >
          <Sheet.Overlay
            animation="medium"
            enterStyle={{ opacity: 0 }}
            exitStyle={{ opacity: 0 }}
            backgroundColor="rgba(32,28,39,0.45)"
          />
          <Sheet.Frame
            padding={20}
            gap={12}
            backgroundColor={c.bgStep}
            borderTopLeftRadius={16}
            borderTopRightRadius={16}
          >
            <Sheet.Handle backgroundColor={c.borderStrong} />
            <T step="hsm">{t("feedback.report")}</T>
            <T step="sm" tone="text3">
              {t("feedback.reportDescriptionLabel")}
            </T>
            <Field
              area
              minHeight={96}
              placeholder={t("feedback.reportPlaceholder")}
              value={reportDescription}
              onChangeText={setReportDescription}
            />
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="ghost" onPress={() => setReportModalOpen(false)}>
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="primary"
                disabled={isReporting || !reportDescription.trim()}
                loading={isReporting}
                onPress={handleReport}
              >
                {isReporting ? t("feedback.sending") : t("feedback.submitReport")}
              </Btn>
            </View>
          </Sheet.Frame>
        </Sheet>
      )}
    </View>
  )
}

/**
 * Memoized export — the parent (AgentTextBlock) re-renders on every typewriter
 * frame while the last message's text reveals (~40 rAF ticks per turn). Without
 * this memo every frame also re-rendered the feedback row of N messages, each
 * calling t() and (pre-migration) logging a missing-key warning 3000+ times
 * per turn. Props are all stable primitives/callbacks, so shallow compare holds.
 */
export const MessageFeedback = React.memo(MessageFeedbackInner)
MessageFeedback.displayName = "MessageFeedback"
