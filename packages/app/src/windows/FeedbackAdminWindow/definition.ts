/**
 * Feedback Admin Window Type Definition
 *
 * Admin panel for the standardized feedback/bug triage (task
 * tn_e86UrjJtC4y9JCOb): one inbox for every report — tool submissions,
 * out-of-band conversation/email reports — with lifecycle tabs
 * (Tracking / Future / Dismissed / Completed), priorities, and
 * reporter-email-on-completion.
 *
 * Only visible to users with role "admin" or "super" (audience: admin).
 */

import { Inbox } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"

const FeedbackAdminWindowContent = lazyWithRetry(() =>
  import("./FeedbackAdminWindowContent").then((m) => ({ default: m.FeedbackAdminWindowContent })),
)

export type FeedbackAdminWindowProps = {
  /** Optional initial lifecycle view (tracking | future | dismissed | completed | all). */
  view?: string
  /** Optional initial search query. */
  search?: string
}

export const feedbackAdminWindowDefinition: WindowTypeDefinition<FeedbackAdminWindowProps> = {
  type: "feedback-admin",
  audience: "admin",
  displayName: "Feedback Admin",
  icon: Inbox,
  phIcon: "tray",
  color: "#8B5CF6",
  component: FeedbackAdminWindowContent,

  defaultSize: { width: 960, height: 720 },
  minSize: { width: 520, height: 420 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.feedbackAdmin"),
  getSubtitle: () => i18n.t("windows.feedbackAdminSub"),

  serialize: (props) => ({
    view: props.view,
    search: props.search,
  }),
  deserialize: (data) => ({
    view: data.view,
    search: data.search,
  }),
}
