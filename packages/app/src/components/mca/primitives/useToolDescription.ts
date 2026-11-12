import { useTranslation } from 'react-i18next';

import type { McaStatusType } from './colors';
import { type DescriptionVars, describeToolCall } from './tool-description';

/**
 * Header description for a tool call, following the description standard
 * (see `tool-description.ts`). `key` is the i18n group under `mca.tools`.
 *
 *   const description = useToolDescription(
 *     'mca.tools.terosCore.grantAppAccess',
 *     status,
 *     { agent: agentName, app: appName },
 *   );
 */
export function useToolDescription(
  key: string,
  status: McaStatusType,
  vars?: DescriptionVars,
): string {
  const { t } = useTranslation();
  return describeToolCall(t as unknown as Parameters<typeof describeToolCall>[0], key, status, vars);
}
