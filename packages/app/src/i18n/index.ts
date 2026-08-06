import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import * as Localization from "expo-localization"
import enUS from "./locales/en-US.json"
import esES from "./locales/es-ES.json"
import koKR from "./locales/ko-KR.json"

export const SUPPORTED_LOCALES = ["en-US", "es-ES", "ko-KR"] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  "en-US": "English",
  "es-ES": "Español",
  "ko-KR": "한국어",
}

export function detectDeviceLocale(): SupportedLocale {
  const deviceLocales = Localization.getLocales()
  for (const loc of deviceLocales) {
    const tag = loc.languageTag
    if (SUPPORTED_LOCALES.includes(tag as SupportedLocale)) {
      return tag as SupportedLocale
    }
    const lang = tag.split("-")[0]
    const match = SUPPORTED_LOCALES.find((s) => s.startsWith(lang))
    if (match) return match
  }
  return "en-US"
}

export function getDateLocale(): string {
  return i18n.language
}

i18n.use(initReactI18next).init({
  resources: {
    "en-US": { translation: enUS },
    "es-ES": { translation: esES },
    "ko-KR": { translation: koKR },
  },
  lng: detectDeviceLocale(),
  fallbackLng: "en-US",
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
})

export default i18n
