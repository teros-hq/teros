/**
 * Users Window Type Definition
 *
 * Admin window to view and manage users.
 */

import { Users } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const UsersWindowContent = lazyWithRetry(() =>
  import("./UsersWindowContent").then((m) => ({ default: m.UsersWindowContent })),
)

export type UsersWindowProps = {}

export const usersWindowDefinition: WindowTypeDefinition<UsersWindowProps> = {
  type: "users",
  audience: "admin",
  displayName: "Users",
  icon: Users,
  phIcon: "users-three",
  color: "#6F27FF",
  component: UsersWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  getTitle: () => i18n.t("windows.users"),
  getSubtitle: () => i18n.t("windows.usersSub"),

  serialize: () => ({}),
  deserialize: () => ({}),
}
