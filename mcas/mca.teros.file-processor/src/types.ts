/**
 * Shared types for file processor MCP
 */

export interface FileProcessorOptions {
  chunkSize?: number; // Pages per chunk (for PDFs)
  maxRetries?: number; // Max retries per chunk
  timeout?: number; // Timeout in milliseconds
}

export interface ProcessorResult {
  markdown: string;
  outputPath: string;
  metadata: {
    inputFile: string;
    fileType: string;
    fileSize: number;
    processingTime: number;
    tokensUsed?: {
      input: number;
      output: number;
    };
    chunks?: number;
  };
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'image' | 'text' | 'document';
    source?: {
      type: 'base64' | 'url';
      media_type: string;
      data?: string;
      url?: string;
    };
    text?: string;
  }>;
}

export interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Supported file types
export const SUPPORTED_EXTENSIONS = {
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  document: ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'],
  text: ['txt', 'md', 'csv'],
} as const;

export type FileType = keyof typeof SUPPORTED_EXTENSIONS;

// Base interface for all processors
export interface FileProcessor {
  process(filePath: string, options?: FileProcessorOptions): Promise<ProcessorResult>;
  supportsType(fileType: FileType): boolean;
}
