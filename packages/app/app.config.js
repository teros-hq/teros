const IS_DEV = process.env.APP_VARIANT === 'development';

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
      output: 'single',
      // PWA Configuration
      name: 'Teros - Asistentes IA Personalizables',
      shortName: 'Teros',
      description: 'Plataforma de asistentes IA con capacidades avanzadas. Automatiza tareas, gestiona proyectos y potencia tu productividad con inteligencia artificial.',
      themeColor: '#000000',
      backgroundColor: '#ffffff',
      display: 'standalone',
      orientation: 'portrait',
      startUrl: '/',
      lang: 'es',
      // PWA Icons - se generarán desde el icon principal
    },
    extra: {
      eas: {
        // projectId will be set by EAS
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
