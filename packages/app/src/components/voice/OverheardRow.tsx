/**
 * OverheardRow — la transparencia hecha fila (ui-evolution.md §3.4) ⭐
 *
 * REQ-9, decisión de Pablo #5: todo lo oído-no-dirigido (passive)
 * se guarda VISIBLE en el chat, en tenue — "Voz · escuchado", sin avatar,
 * tipografía un tono menor. Es la prueba visible de que nada entra en
 * contexto en secreto (UX §6.2, §10.4).
 *
 * Densidad (feedback de Pablo, 20:20 — "aún más tenue"): sin caja, sin
 * borde, sin icono — solo la frase en gris itálica y su meta debajo. Lo
 * overheard no compite por forma con nada: se lee al pasar, como se oyó.
 *
 * En `passive` es TODO lo que aparece, acumulándose en silencio — cero
 * respuestas alrededor (AC-3).
 *
 * Diferencia con una burbuja de voz normal (UX §8.2): la normal lleva meta
 * "Voz" a la misma altura que el texto (contenido de primera clase); la
 * overheard es un tono menor — se leyó, pero no entró al diálogo.
 *
 * El gris es `c.text3` — el tono "escuchado sin respuesta" del lenguaje de
 * voz (el mismo paso neutro que la luna de `passive` en el orbe), en claro
 * y en oscuro.
 *
 * Gated by the voice.mode-ui feature flag (mounted only by v2 surfaces).
 */

import React from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { getDateLocale } from "../../i18n"
import { T } from "../ui/ds"

export interface OverheardRowProps {
  /** The overheard phrase, verbatim. */
  text: string
  /** When it was heard. */
  timestamp: Date | number
}

export function OverheardRow({ text, timestamp }: OverheardRowProps) {
  const { t } = useTranslation()
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  const timeString = date.toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <View
      style={[
        // Pablo (PoC 2026-10-31): overheard is the USER's side of the thread —
        // right-aligned like their messages, just muted.
        { alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "85%", gap: 2, opacity: 0.85 },
        Platform.OS === "web" ? ({ userSelect: "text" } as any) : null,
      ]}
    >
      <T step="sm" tone="text3" style={{ fontStyle: "italic", textAlign: "right" }}>
        {text}
      </T>
      {/* Meta — "13:26 · Voz · escuchado": un tono menor que la burbuja normal */}
      <T step="codenote" tone="text3" style={{ textTransform: "none", opacity: 0.85 }}>
        {timeString} · {t("voice.overheard.meta", { defaultValue: "Voz · escuchado" })}
      </T>
    </View>
  )
}
