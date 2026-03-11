import { config } from '@tamagui/config';
import { createTamagui } from 'tamagui';

// Teros Custom Theme - Override default dark theme
const appConfig = createTamagui({
  ...config,
  themes: {
    ...config.themes,
    // Override the default 'dark' theme with Teros colors
    dark: {
      ...config.themes.dark,
      background: '#000000',
      backgroundHover: '#0A0A0A',
      backgroundPress: '#1C1C1E',
      backgroundFocus: '#1C1C1E',
      backgroundSoft: '#0A0A0A',
      backgroundStrong: '#1C1C1E',
      backgroundTransparent: 'rgba(0, 0, 0, 0.8)',
      color: '#FFFFFF',
      colorHover: '#F2F2F7',
      colorPress: '#F2F2F7',
      colorFocus: '#F2F2F7',
      borderColor: '#2C2C2E',
      borderColorHover: '#3A3A3C',
      borderColorFocus: '#06B6D4',
      placeholderColor: '#8E8E93',

      // Teros Brand - User message bubbles
      blue: '#0E7490', // cyan-700 (darker for better contrast with white text)
      blue1: '#0E7490',
      blue2: '#155E75', // cyan-800
      blue3: '#164E63', // cyan-900

      red: '#FF453A',
      red1: '#FF453A',
      red2: '#FF6259',
      red3: '#FF2D20',

      gray: '#8E8E93',
      gray1: '#8E8E93',
      gray2: '#98989D',
      gray3: '#6E6E73',
    },
  },
});

export type AppConfig = typeof appConfig;

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default appConfig;
