/**
 * Secrets Manager
 *
 * Manages system and MCA secrets from .secrets/ directory.
 * No fallback to environment variables.
 */

import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import type { MCASecretsRegistry, SystemSecretsRegistry } from "./types"

interface SecretFile {
  [key: string]: any
}

class SecretsManager {
  private systemSecrets: Map<string, SecretFile> = new Map()
  private mcaSecrets: Map<string, SecretFile> = new Map()
  private basePath: string
  private loaded: boolean = false

  constructor(basePath: string = ".secrets") {
    this.basePath = basePath
  }

  /**
   * Load all secrets from .secrets/ directory
   */
  async load(): Promise<void> {
    console.log("🔐 Loading secrets from", this.basePath)

    // Load system secrets
    this.loadSystemSecrets()

    // Load MCA secrets
    this.loadMCASecrets()

    this.loaded = true

    console.log("✅ Secrets loaded successfully")
    console.log(`   - System secrets: ${this.systemSecrets.size}`)
    console.log(`   - MCA secrets: ${this.mcaSecrets.size}`)
  }

  /**
   * Reload all secrets (for hot-reload)
   */
  async reload(): Promise<void> {
    this.systemSecrets.clear()
    this.mcaSecrets.clear()
    this.loaded = false
    await this.load()
  }

  /**
   * Get system secret (optional - returns undefined if not found)
   */
  system<K extends keyof SystemSecretsRegistry>(name: K): SystemSecretsRegistry[K] | undefined
  system<T = SecretFile>(name: string): T | undefined
  system(name: string): any {
    this.ensureLoaded()
    return this.systemSecrets.get(name)
  }

  /**
   * Get MCA secret (optional - returns undefined if not found)
   */
  mca<K extends keyof MCASecretsRegistry>(mcaId: K): MCASecretsRegistry[K] | undefined
  mca<T = SecretFile>(mcaId: string): T | undefined
  mca(mcaId: string): any {
    this.ensureLoaded()
    return this.mcaSecrets.get(mcaId)
  }

  /**
   * Get required system secret (throws if not found)
   */
  requireSystem<K extends keyof SystemSecretsRegistry>(name: K): SystemSecretsRegistry[K]
  requireSystem<T = SecretFile>(name: string): T
  requireSystem(name: string): any {
    const secret = this.system(name)
    if (!secret) {
      throw new Error(
        `Required system secret '${name}' not found. ` +
          `Expected file: ${this.getSystemPath(name)}`,
      )
    }
    return secret
  }

  /**
   * Get required MCA secret (throws if not found)
   */
  requireMCA<K extends keyof MCASecretsRegistry>(mcaId: K): MCASecretsRegistry[K]
  requireMCA<T = SecretFile>(mcaId: string): T
  requireMCA(mcaId: string): any {
    const secret = this.mca(mcaId)
    if (!secret) {
      throw new Error(
        `Required MCA secret '${mcaId}' not found. ` + `Expected file: ${this.getMCAPath(mcaId)}`,
      )
    }
    return secret
  }

  /**
   * Check if system secret exists
   */
  hasSystem(name: string): boolean {
    this.ensureLoaded()
    return this.systemSecrets.has(name)
  }

  /**
   * Check if MCA secret exists
   */
  hasMCA(mcaId: string): boolean {
    this.ensureLoaded()
    return this.mcaSecrets.has(mcaId)
  }

  /**
   * Get system secret (typed)
   */
  getSystem<T = any>(name: string): T {
    return this.requireSystem(name) as T
  }

  /**
   * Get optional system secret (typed)
   */
  getSystemOptional<T = any>(name: string): T | undefined {
    try {
      return this.system(name) as T
    } catch {
      return undefined
    }
  }

  /**
   * Ensure secrets are loaded
   */
  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("Secrets not loaded. Call secrets.load() first.")
    }
  }

  /**
   * Load system secrets from .secrets/system/
   */
  private loadSystemSecrets(): void {
    const systemPath = join(this.basePath, "system")

    if (!existsSync(systemPath)) {
      console.warn(`⚠️  System secrets directory not found: ${systemPath}`)
      return
    }

    // Auto-discover all .json files (excluding .example.json)
    const files = readdirSync(systemPath)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".example.json"))
      .map((f) => f.replace(".json", ""))

    for (const name of files) {
      const filePath = this.getSystemPath(name)

      try {
        const content = this.readSecretFile(filePath)
        this.systemSecrets.set(name, content)
        console.log(`   ✓ Loaded system secret: ${name}`)
      } catch (error: any) {
        console.error(`   ✗ Failed to load system secret '${name}':`, error.message)
        throw error
      }
    }
  }

  /**
   * Load MCA secrets from .secrets/mcas/
   */
  private loadMCASecrets(): void {
    const mcasPath = join(this.basePath, "mcas")

    if (!existsSync(mcasPath)) {
      console.warn(`⚠️  MCAs secrets directory not found: ${mcasPath}`)
      return
    }

    // Auto-discover all MCA directories
    const mcaDirs = readdirSync(mcasPath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)

    for (const mcaId of mcaDirs) {
      const filePath = this.getMCAPath(mcaId)

      if (existsSync(filePath)) {
        try {
          const content = this.readSecretFile(filePath)
          this.mcaSecrets.set(mcaId, content)
          console.log(`   ✓ Loaded MCA secret: ${mcaId}`)
        } catch (error: any) {
          console.error(`   ✗ Failed to load MCA secret '${mcaId}':`, error.message)
          throw error
        }
      }
    }
  }

  /**
   * Read and parse secret file
   */
  private readSecretFile(filePath: string): SecretFile {
    try {
      const content = readFileSync(filePath, "utf-8")
      const parsed = JSON.parse(content)

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Secret file must contain a JSON object")
      }

      return parsed
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in secret file: ${filePath}`)
      }
      throw error
    }
  }

  /**
   * Get path to system secret file
   */
  private getSystemPath(name: string): string {
    return join(this.basePath, "system", `${name}.json`)
  }

  /**
   * Get path to MCA secret file
   */
  private getMCAPath(mcaId: string): string {
    return join(this.basePath, "mcas", mcaId, "credentials.json")
  }

  /**
   * Validate that a secret has required keys
   */
  validateSecret(secret: SecretFile, requiredKeys: string[], secretName: string): void {
    for (const key of requiredKeys) {
      if (!(key in secret)) {
        throw new Error(`Missing required key '${key}' in secret '${secretName}'`)
      }

      if (secret[key] === "" || secret[key] === null || secret[key] === undefined) {
        throw new Error(`Empty value for required key '${key}' in secret '${secretName}'`)
      }
    }
  }
}

// Export class for type annotations
export { SecretsManager }

// Singleton instance
export const secrets = new SecretsManager()

// Re-export types for convenience
export type {
  AdminSecret,
  AnthropicSecret,
  AuthSecret,
  DatabaseSecret,
  ElevenLabsSecret,
  EmailSecret,
  EncryptionSecret,
  GmailSecret,
  GoogleOAuthSecret,
  MCASecretsRegistry,
  OAuthConfigSecret,
  OpenAISecret,
  PerplexitySecret,
  SystemSecretsRegistry,
  TranscriptionSecret,
} from "./types"

// Export a singleton instance
export const secretsManager = new SecretsManager()
