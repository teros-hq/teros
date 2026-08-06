/**
 * useFileUpload Hook
 *
 * Handles file uploads for chat messages (images, documents, etc.)
 * Supports multiple file selection and batch upload.
 * Works on web platform using native file input.
 */

import { useCallback, useRef, useState } from "react"
import { Platform } from "react-native"
import { getTerosClient } from "../services/terosClientSingleton"
import { useAuthStore } from "../store/authStore"

// Allowed file types - accepts all common types
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
]
const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/html",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]
const ALLOWED_ARCHIVE_TYPES = [
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
]
const ALLOWED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
  "audio/flac",
]
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"]
const ALLOWED_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_DOCUMENT_TYPES,
  ...ALLOWED_ARCHIVE_TYPES,
  ...ALLOWED_AUDIO_TYPES,
  ...ALLOWED_VIDEO_TYPES,
  "application/octet-stream", // Allow generic binary files
]

// Max file size (100MB)
const MAX_FILE_SIZE = 100 * 1024 * 1024

export interface UploadedFile {
  /** Unique file ID from backend */
  fileId: string
  /** Public URL to access the file */
  url: string
  /** Original filename */
  originalName: string
  /** MIME type */
  mimeType: string
  /** File size in bytes */
  size: number
  /** Image dimensions (only for images) */
  dimensions?: {
    width: number
    height: number
  }
}

export interface FileUploadState {
  /** Currently selected files (before upload) */
  selectedFiles: File[]
  /** Preview URLs for selected files (local blob URLs, keyed by index) */
  previewUrls: Record<number, string>
  /** Image dimensions keyed by index */
  dimensions: Record<number, { width: number; height: number }>
  /** Upload in progress */
  isUploading: boolean
  /** Overall upload progress (0-100) */
  progress: number
  /** Error message if upload failed */
  error: string | null
  /** Uploaded file info (after successful upload) */
  uploadedFiles: UploadedFile[]
}

export interface UseFileUploadReturn extends FileUploadState {
  /** Open file picker dialog (multi-select) */
  pickFile: () => void
  /** Upload all selected files */
  upload: () => Promise<UploadedFile[]>
  /** Clear all selected files and reset state */
  clear: () => void
  /** Add files programmatically (from drag-drop or programmatic selection) */
  addFiles: (files: File[] | FileList) => void
  /** Remove a specific file by index */
  removeFile: (index: number) => void
}

/**
 * Validate a single file — returns error string or null if valid.
 */
function validateFile(file: File): string | null {
  if (file.type && !ALLOWED_TYPES.includes(file.type)) {
    const blockedTypes = ["application/x-msdownload", "application/x-executable"]
    if (blockedTypes.includes(file.type)) {
      return `File type not allowed: ${file.type}`
    }
  }
  if (file.size > MAX_FILE_SIZE) {
    return `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`
  }
  return null
}

/**
 * Upload a single file via XMLHttpRequest.
 */
function uploadSingleFile(
  file: File,
  apiBaseUrl: string,
  sessionToken: string,
  onProgress: (pct: number) => void,
): Promise<UploadedFile> {
  const formData = new FormData()
  formData.append("file", file)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText)
          if (response.success && response.file) {
            resolve(response.file)
          } else {
            reject(new Error(response.error || "Upload failed"))
          }
        } catch {
          reject(new Error("Invalid response from server"))
        }
      } else {
        try {
          const response = JSON.parse(xhr.responseText)
          reject(new Error(response.error || `Upload failed: ${xhr.status}`))
        } catch {
          reject(new Error(`Upload failed: ${xhr.status}`))
        }
      }
    }

    xhr.onerror = () => reject(new Error("Network error during upload"))
    xhr.open("POST", `${apiBaseUrl}/api/upload/static`)
    xhr.setRequestHeader("Authorization", `Bearer ${sessionToken}`)
    xhr.send(formData)
  })
}

/**
 * Hook for handling file uploads (multiple files supported)
 */
export function useFileUpload(): UseFileUploadReturn {
  const sessionToken = useAuthStore((state) => state.sessionToken)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const addFilesRef = useRef<(files: File[] | FileList) => void>(() => {})

  const client = getTerosClient()
  const API_BASE_URL = client?.getBackendBaseUrl() || process.env.EXPO_PUBLIC_BACKEND_URL || ""

  const [state, setState] = useState<FileUploadState>({
    selectedFiles: [],
    previewUrls: {},
    dimensions: {},
    isUploading: false,
    progress: 0,
    error: null,
    uploadedFiles: [],
  })

  // Add files (from picker, drag-drop, or programmatic)
  const addFiles = useCallback((files: File[] | FileList) => {
    const fileArray = Array.isArray(files) ? files : Array.from(files)

    // Validate all files first
    const errors: string[] = []
    const validFiles: File[] = []

    fileArray.forEach((file) => {
      const err = validateFile(file)
      if (err) {
        errors.push(`${file.name}: ${err}`)
      } else {
        validFiles.push(file)
      }
    })

    if (errors.length > 0) {
      setState((prev) => ({
        ...prev,
        error: errors.join("; "),
      }))
      if (validFiles.length === 0) return
    }

    setState((prev) => {
      const combined = [...prev.selectedFiles, ...validFiles]
      const updatedPreviewUrls: Record<number, string> = { ...prev.previewUrls }
      const updatedDimensions: Record<number, { width: number; height: number }> = {
        ...prev.dimensions,
      }

      validFiles.forEach((file) => {
        const idx = combined.indexOf(file)
        if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
          const url = URL.createObjectURL(file)
          updatedPreviewUrls[idx] = url

          // Load dimensions asynchronously
          const img = new Image()
          img.onload = () => {
            setState((s) => ({
              ...s,
              dimensions: { ...s.dimensions, [idx]: { width: img.naturalWidth, height: img.naturalHeight } },
            }))
            URL.revokeObjectURL(img.src)
          }
          img.onerror = () => {
            URL.revokeObjectURL(img.src)
          }
          img.src = url
        }
      })

      return {
        ...prev,
        selectedFiles: combined,
        previewUrls: updatedPreviewUrls,
        dimensions: updatedDimensions,
        error: prev.error && validFiles.length === 0 ? prev.error : null,
      }
    })
  }, [])

  // Keep ref in sync so getFileInput always sees latest
  addFilesRef.current = addFiles

  // Create hidden file input on first use (web only, multi-select)
  const getFileInput = useCallback(() => {
    if (Platform.OS !== "web") return null

    if (!fileInputRef.current) {
      const input = document.createElement("input")
      input.type = "file"
      input.multiple = true
      input.accept = ALLOWED_TYPES.join(",")
      input.style.display = "none"
      document.body.appendChild(input)
      fileInputRef.current = input

      input.onchange = (e) => {
        const files = (e.target as HTMLInputElement).files
        if (files && files.length > 0) {
          addFilesRef.current(Array.from(files))
        }
        // Reset input so same files can be selected again
        input.value = ""
      }
    }

    return fileInputRef.current
  }, [])

  // Open file picker
  const pickFile = useCallback(() => {
    if (Platform.OS !== "web") {
      console.warn("File picker not implemented for native platforms yet")
      return
    }

    const input = getFileInput()
    input?.click()
  }, [getFileInput])

  // Remove a specific file by index
  const removeFile = useCallback((index: number) => {
    setState((prev) => {
      const file = prev.selectedFiles[index]
      if (!file) return prev

      // Revoke preview URL if exists
      const previewUrl = prev.previewUrls[index]
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }

      const newFiles = prev.selectedFiles.filter((_, i) => i !== index)
      const newPreviewUrls: Record<number, string> = {}
      const newDimensions: Record<number, { width: number; height: number }> = {}

      // Re-index previews and dimensions
      newFiles.forEach((_, newIdx) => {
        const oldIdx = newIdx < index ? newIdx : newIdx + 1
        if (prev.previewUrls[oldIdx]) {
          newPreviewUrls[newIdx] = prev.previewUrls[oldIdx]
        }
        if (prev.dimensions[oldIdx]) {
          newDimensions[newIdx] = prev.dimensions[oldIdx]
        }
      })

      return {
        ...prev,
        selectedFiles: newFiles,
        previewUrls: newPreviewUrls,
        dimensions: newDimensions,
      }
    })
  }, [])

  // Upload all selected files
  const upload = useCallback(async (): Promise<UploadedFile[]> => {
    const { selectedFiles } = state

    if (selectedFiles.length === 0) {
      setState((prev) => ({ ...prev, error: "No files selected" }))
      return []
    }

    if (!sessionToken) {
      setState((prev) => ({ ...prev, error: "Not authenticated" }))
      return []
    }

    setState((prev) => ({ ...prev, isUploading: true, progress: 0, error: null }))

    const progressMap = new Map<number, number>()
    const updateOverallProgress = () => {
      const total = Array.from(progressMap.values()).reduce((sum, p) => sum + p, 0)
      const avg = Math.round(total / selectedFiles.length)
      setState((prev) => ({ ...prev, progress: avg }))
    }

    try {
      const results = await Promise.all(
        selectedFiles.map((file, idx) =>
          uploadSingleFile(
            file,
            API_BASE_URL,
            sessionToken,
            (pct) => {
              progressMap.set(idx, pct)
              updateOverallProgress()
            },
          ),
        ),
      )

      setState((prev) => ({
        ...prev,
        isUploading: false,
        progress: 100,
        uploadedFiles: results,
      }))

      return results
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Upload failed"
      setState((prev) => ({
        ...prev,
        isUploading: false,
        progress: 0,
        error: errorMessage,
      }))
      return []
    }
  }, [state.selectedFiles, sessionToken])

  // Clear all state
  const clear = useCallback(() => {
    // Revoke all preview URLs
    Object.values(state.previewUrls).forEach((url) => {
      URL.revokeObjectURL(url)
    })

    setState({
      selectedFiles: [],
      previewUrls: {},
      dimensions: {},
      isUploading: false,
      progress: 0,
      error: null,
      uploadedFiles: [],
    })
  }, [state.previewUrls])

  return {
    ...state,
    pickFile,
    upload,
    clear,
    addFiles,
    removeFile,
  }
}

/**
 * Check if a file type is an image
 */
export function isImageFile(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.includes(mimeType)
}

/**
 * Get file type category
 */
export function getFileCategory(
  mimeType: string,
): "image" | "document" | "audio" | "video" | "archive" | "unknown" {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return "image"
  if (ALLOWED_DOCUMENT_TYPES.includes(mimeType)) return "document"
  if (ALLOWED_AUDIO_TYPES.includes(mimeType)) return "audio"
  if (ALLOWED_VIDEO_TYPES.includes(mimeType)) return "video"
  if (ALLOWED_ARCHIVE_TYPES.includes(mimeType)) return "archive"
  return "unknown"
}
