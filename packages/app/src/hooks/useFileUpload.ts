/**
 * useFileUpload Hook
 *
 * Handles file uploads for chat messages (images, documents, etc.)
 * Works on web platform using native file input.
 */

import { useCallback, useRef, useState } from "react"
import { Platform } from "react-native"
import { getTerosClient } from "../../app/_layout"
import { useAuthStore } from "../store/authStore"

// Allowed file types - now accepts all common types
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
  /** Currently selected file (before upload) */
  selectedFile: File | null
  /** Preview URL for selected file (local blob URL) */
  previewUrl: string | null
  /** Image dimensions (detected locally for preview) */
  dimensions: { width: number; height: number } | null
  /** Upload in progress */
  isUploading: boolean
  /** Upload progress (0-100) */
  progress: number
  /** Error message if upload failed */
  error: string | null
  /** Uploaded file info (after successful upload) */
  uploadedFile: UploadedFile | null
}

export interface UseFileUploadReturn extends FileUploadState {
  /** Open file picker dialog */
  pickFile: () => void
  /** Upload the selected file */
  upload: () => Promise<UploadedFile | null>
  /** Clear selected file and reset state */
  clear: () => void
  /** Select a specific file programmatically */
  selectFile: (file: File) => void
}

/**
 * Hook for handling file uploads
 */
export function useFileUpload(): UseFileUploadReturn {
  const sessionToken = useAuthStore((state) => state.sessionToken)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Get backend URL from TerosClient (derives from WebSocket URL)
  const client = getTerosClient()
  const API_BASE_URL = client?.getBackendBaseUrl() || process.env.EXPO_PUBLIC_BACKEND_URL || ""

  const [state, setState] = useState<FileUploadState>({
    selectedFile: null,
    previewUrl: null,
    isUploading: false,
    progress: 0,
    error: null,
    uploadedFile: null,
  })

  // Create hidden file input on first use (web only)
  const getFileInput = useCallback(() => {
    if (Platform.OS !== "web") return null

    if (!fileInputRef.current) {
      const input = document.createElement("input")
      input.type = "file"
      input.accept = ALLOWED_TYPES.join(",")
      input.style.display = "none"
      document.body.appendChild(input)
      fileInputRef.current = input

      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (file) {
          handleFileSelected(file)
        }
        // Reset input so same file can be selected again
        input.value = ""
      }
    }

    return fileInputRef.current
  }, [])

  // Handle file selection
  const handleFileSelected = useCallback((file: File) => {
    // Validate file type (allow most common types, or generic binary)
    // If the browser doesn't recognize the type, it may be empty - allow it
    if (file.type && !ALLOWED_TYPES.includes(file.type)) {
      // Be lenient - only block truly dangerous types
      const blockedTypes = ["application/x-msdownload", "application/x-executable"]
      if (blockedTypes.includes(file.type)) {
        setState((prev) => ({
          ...prev,
          error: `File type not allowed: ${file.type}`,
        }))
        return
      }
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setState((prev) => ({
        ...prev,
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      }))
      return
    }

    // Create preview URL for images
    let previewUrl: string | null = null
    const dimensions: { width: number; height: number } | null = null

    if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
      previewUrl = URL.createObjectURL(file)
      // Load image to get dimensions
      const img = new Image()
      img.onload = () => {
        const w = img.naturalWidth
        const h = img.naturalHeight
        setState((prev) => ({
          ...prev,
          selectedFile: file,
          previewUrl,
          dimensions: { width: w, height: h },
          isUploading: false,
          progress: 0,
          error: null,
          uploadedFile: null,
        }))
        URL.revokeObjectURL(img.src)
      }
      img.onerror = () => {
        setState((prev) => ({
          ...prev,
          selectedFile: file,
          previewUrl,
          dimensions: null,
          isUploading: false,
          progress: 0,
          error: null,
          uploadedFile: null,
        }))
      }
      img.src = previewUrl
    } else {
      setState({
        selectedFile: file,
        previewUrl,
        dimensions: null,
        isUploading: false,
        progress: 0,
        error: null,
        uploadedFile: null,
      })
    }
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

  // Select file programmatically
  const selectFile = useCallback(
    (file: File) => {
      handleFileSelected(file)
    },
    [handleFileSelected],
  )

  // Upload the selected file
  const upload = useCallback(async (): Promise<UploadedFile | null> => {
    const { selectedFile } = state

    if (!selectedFile) {
      setState((prev) => ({ ...prev, error: "No file selected" }))
      return null
    }

    if (!sessionToken) {
      setState((prev) => ({ ...prev, error: "Not authenticated" }))
      return null
    }

    setState((prev) => ({ ...prev, isUploading: true, progress: 0, error: null }))

    try {
      const formData = new FormData()
      formData.append("file", selectedFile)

      // Use XMLHttpRequest for progress tracking
      const result = await new Promise<UploadedFile>((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const progress = Math.round((e.loaded / e.total) * 100)
            setState((prev) => ({ ...prev, progress }))
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
            } catch (e) {
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

        xhr.onerror = () => {
          reject(new Error("Network error during upload"))
        }

        xhr.open("POST", `${API_BASE_URL}/api/upload/static`)
        xhr.setRequestHeader("Authorization", `Bearer ${sessionToken}`)
        xhr.send(formData)
      })

      setState((prev) => ({
        ...prev,
        isUploading: false,
        progress: 100,
        uploadedFile: result,
      }))

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Upload failed"
      setState((prev) => ({
        ...prev,
        isUploading: false,
        progress: 0,
        error: errorMessage,
      }))
      return null
    }
  }, [state.selectedFile, sessionToken])

  // Clear state
  const clear = useCallback(() => {
    // Revoke preview URL to free memory
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl)
    }

    setState({
      selectedFile: null,
      previewUrl: null,
      isUploading: false,
      progress: 0,
      error: null,
      uploadedFile: null,
    })
  }, [state.previewUrl])

  return {
    ...state,
    pickFile,
    upload,
    clear,
    selectFile,
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
