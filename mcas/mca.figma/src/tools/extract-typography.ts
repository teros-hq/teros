import type { ToolConfig } from "@teros/mca-sdk"
import { figmaRequest } from "../lib"
import {
  extractTypographyFromNode,
  type FigmaFile,
  type FigmaTypeStyle,
  formatTypographyAsCss,
  formatTypographyAsTailwind,
} from "./_helpers"
import { validateFileKey } from "./utils"

const VALID_FORMATS = ["css", "tailwind", "json"] as const
type TypographyFormat = (typeof VALID_FORMATS)[number]

export const extractTypography: ToolConfig = {
  description:
    "Extract typography styles (font family, size, weight, line height, letter spacing) used in TEXT nodes of a Figma file. Returns { count, output: string, format }. Params: fileKey, format? (default css).",
  parameters: {
    type: "object",
    properties: {
      fileKey: { type: "string", description: "The file key from a Figma URL." },
      format: {
        type: "string",
        enum: ["css", "tailwind", "json"],
        description: "Output format. Default css.",
      },
    },
    required: ["fileKey"],
  },
  annotations: { readOnlyHint: true, version: "2.1.0", stability: "stable" },
  handler: async (args, context) => {
    const { fileKey, format } = args as {
      fileKey: string
      format?: TypographyFormat
    }

    const safeKey = validateFileKey(fileKey)
    const safeFormat: TypographyFormat = format && VALID_FORMATS.includes(format) ? format : "css"

    const file = await figmaRequest<FigmaFile>(`/files/${safeKey}?depth=100`, context)

    const styles = new Map<string, FigmaTypeStyle>()
    extractTypographyFromNode(file.document, styles)
    const styleArray = Array.from(styles.values())

    let output: string
    if (safeFormat === "css") output = formatTypographyAsCss(styleArray)
    else if (safeFormat === "tailwind") output = formatTypographyAsTailwind(styleArray)
    else output = JSON.stringify(styleArray, null, 2)

    return { count: styleArray.length, output, format: safeFormat }
  },
}
