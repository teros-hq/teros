/**
 * A file output drawn as a page: a PDF's first page rendered with pdf.js on
 * an A4 sheet (the browser viewer in an iframe when that fails), images on
 * paper, an HTML page in a sandboxed iframe (TODOOV-REQ-9), anything else as
 * a quiet tile. `full` is the fullscreen variant.
 */
import React, { useEffect, useState } from "react"
import { Image, Platform, View } from "react-native"
import { FileTile, usePageStyle } from "./FileCard"
import { HtmlPreview } from "./HtmlPreview"
import { fileKind } from "./io"
import { renderPdfFirstPage } from "./pdfPage"

export function FilePreview({ url, name, mime, full }: { url: string; name: string; mime: string; full?: boolean }) {
  const page = usePageStyle()
  const kind = fileKind(mime, name)
  if (kind === "pdf" && Platform.OS === "web") return <PdfPage url={url} name={name} full={full} />
  if (kind === "html") return <HtmlPreview url={url} name={name} full={full} />
  if (kind === "image") {
    return (
      <View style={[...page, { aspectRatio: undefined, minHeight: 180, alignItems: "center", justifyContent: "center", padding: full ? 0 : 8 }]}>
        <Image source={{ uri: url }} resizeMode="contain" style={{ width: "100%", height: full ? 640 : 300 }} accessibilityLabel={name} />
      </View>
    )
  }
  return <FileTile name={name} />
}

function PdfPage({ url, name, full }: { url: string; name: string; full?: boolean }) {
  const page = usePageStyle()
  // undefined = rendering, null = pdf.js failed (fall back to the browser viewer)
  const [img, setImg] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setImg(undefined)
    renderPdfFirstPage(url, full ? 1500 : 900).then((d) => alive && setImg(d))
    return () => {
      alive = false
    }
  }, [url, full])
  if (img) {
    return (
      <View style={page}>
        <Image source={{ uri: img }} resizeMode="contain" style={{ width: "100%", height: "100%" }} accessibilityLabel={name} />
      </View>
    )
  }
  if (img === undefined) return <View style={page} />
  return (
    <View style={page}>
      {React.createElement("iframe", {
        src: `${url}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`,
        title: name,
        style: { width: "100%", height: "100%", border: 0, background: "#fff", pointerEvents: full ? "auto" : "none" },
      })}
    </View>
  )
}
