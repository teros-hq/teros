/**
 * Not Found — pretty 404 (session URL phase)
 *
 * A meaningless URL no longer silently redirects: it renders a calm editorial
 * screen — "this page is not here" — with one primary action: go to the root
 * (which resolves the active workspace). Old deep-URL bookmarks land here
 * instead of bouncing silently.
 *
 * Visuals: EditorialScreen (the shared editorial card, extracted from this
 * very screen — also used by the root resolver's failure state).
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { EditorialScreen } from '../src/components/ui/EditorialScreen';

export default function NotFound() {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <EditorialScreen
      code="404"
      title={t('notFoundScreen.title')}
      description={t('notFoundScreen.description')}
      actionLabel={t('notFoundScreen.goHome')}
      onAction={() => router.replace('/')}
    />
  );
}
