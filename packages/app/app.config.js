const IS_DEV = process.env.NODE_ENV === 'development';

export default {
  expo: {
    name: IS_DEV ? 'TEROS dev' : 'TEROS',
    slug: 'app',
    version: '1.0.0',
    scheme: IS_DEV ? 'teros-dev' : 'teros',
    orientation: 'portrait',
    icon: IS_DEV ? './assets/icon-dev.png' : './assets/icon.png',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    experiments: {
      autolinkingModuleResolution: true,
    },
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: IS_DEV ? 'ai.teros.chat-dev' : 'ai.teros.chat',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: IS_DEV ? './assets/adaptive-icon-dev.png' : './assets/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      package: IS_DEV ? 'ai.teros.chat.dev' : 'ai.teros.chat',
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
      // TEMPORARY: single bundle for all environments.
      // With 'static' output, Metro generates a separate JS chunk per
      // React.lazy() window. On iOS Safari mobile, when the virtual keyboard
      // opens it can trigger a layout reflow that remounts window components.
      // The remount fires a fresh dynamic import() for the chunk — if the
      // network is flaky or Safari has evicted the HTTP cache, the import
      // stalls and the Suspense fallback (TerosLoading) shows forever.
      // 'single' bundles everything into one file, eliminating dynamic
      // imports entirely. This trades initial load size for stability.
      // TODO: re-enable 'static' once the mobile keyboard remount issue is
      // fixed (prevent unnecessary remounts on viewport resize, or add
      // service-worker precaching for hashed chunks).
      output: 'single',
      // PWA Configuration
      name: 'Teros - Customizable AI Assistants',
      shortName: 'Teros',
      description: 'AI assistant platform with advanced capabilities. Automate tasks, manage projects, and boost your productivity with artificial intelligence.',
      themeColor: '#000000',
      backgroundColor: '#ffffff',
      display: 'standalone',
      orientation: 'portrait',
      startUrl: '/',
      lang: 'en',
    },
    extra: {
      eas: {
        projectId: '7d82a725-7473-485e-a30f-432007d70c42'
      },
    },
    plugins: [
      'expo-font',
      // Sentry is optional. To enable error tracking, set SENTRY_ORG and SENTRY_PROJECT
      // env vars and configure EXPO_PUBLIC_SENTRY_DSN in your .env file.
      ...(process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
        ? [
            [
              '@sentry/react-native/expo',
              {
                organization: process.env.SENTRY_ORG,
                project: process.env.SENTRY_PROJECT,
              },
            ],
          ]
        : []),
    ],
  },
};
