/**
 * agent.generate-profile — Generate a unique agent profile using LLM
 */

import { LLMClientFactory } from '@teros/core'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import type { ProviderService } from '../../../services/provider-service'

interface Agent {
  ownerId: string
  name: string
}

interface AgentCore {
  coreId: string
  name: string
  fullName: string
  systemPrompt: string
  personality: string[]
  capabilities: string[]
  avatarUrl: string
}

interface GenerateProfileData {
  coreId: string
  excludeNames?: string[]
}

interface GeneratedProfile {
  name: string
  fullName: string
  role: string
  intro: string
  responseStyle: string
}

const SYSTEM_USER_ID = 'system'

function buildGenerationPrompt(core: AgentCore, excludeNames: string[]): string {
  const excludeList =
    excludeNames.length > 0
      ? `\n\nIMPORTANT: Do NOT use any of these names (they are already taken): ${excludeNames.join(', ')}`
      : ''

  return `Generate a unique AI assistant persona based on these characteristics:

Core Engine: ${core.name} (${core.fullName})
Personality traits: ${core.personality.join(', ')}
Capabilities: ${core.capabilities.join(', ')}
${excludeList}

Create a persona with:
1. A unique first name (feminine, professional, memorable - like Alice, Berta, Clara, Diana, Elena, Fiona, Grace, Helena, Iris, Julia)
2. A unique last name (nature/professional themed - like Evergreen, Thornwood, Westbrook, Ashford, Blackwood, Sterling, Rivers, Hartwell)
3. A specific role title (not just "Assistant" - be creative like "Technical Advisor", "Development Partner", "Research Analyst")
4. A detailed introduction (3-4 paragraphs) that:
   - Introduces the persona in first person
   - Describes their focus and approach
   - Lists primary responsibilities (3-4 items)
   - Lists secondary responsibilities (3-4 items)
5. A response style keyword (friendly, professional, collaborative, analytical, concise, etc.)

Respond with ONLY valid JSON in this exact format:
{
  "name": "FirstName",
  "fullName": "FirstName LastName", 
  "role": "Specific Role Title",
  "intro": "Full introduction text...",
  "responseStyle": "keyword"
}`
}

function parseGeneratedProfile(response: string): GeneratedProfile {
  let jsonStr = response.trim()

  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.slice(7)
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.slice(3)
  }
  if (jsonStr.endsWith('```')) {
    jsonStr = jsonStr.slice(0, -3)
  }
  jsonStr = jsonStr.trim()

  try {
    const parsed = JSON.parse(jsonStr)

    if (!parsed.name || !parsed.fullName || !parsed.role || !parsed.intro) {
      throw new Error('Missing required fields in generated profile')
    }

    return {
      name: parsed.name,
      fullName: parsed.fullName,
      role: parsed.role,
      intro: parsed.intro,
      responseStyle: parsed.responseStyle || 'friendly',
    }
  } catch {
    console.error('[agent.generate-profile] Failed to parse generated profile:', response)
    throw new Error('Failed to parse generated profile from LLM response')
  }
}

export function createGenerateProfileHandler(db: Db, providerService: ProviderService) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function generateProfile(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GenerateProfileData
    console.log(`[agent.generate-profile] Generating agent profile for user: ${ctx.userId}`, data)

    const { coreId, excludeNames = [] } = data

    const core = await agentCores.findOne({ coreId })
    if (!core) {
      throw new HandlerError('CORE_NOT_FOUND', `Agent core '${coreId}' not found`)
    }

    const existingAgents = await agents.find({ ownerId: ctx.userId }).toArray()
    const existingNames = existingAgents.map((a) => a.name)
    const allExcludedNames = [...new Set([...excludeNames, ...existingNames])]

    try {
      const providers = await providerService.listUserProviders(SYSTEM_USER_ID)
      if (providers.length === 0) {
        throw new Error('No provider configured for system user. Run: npm run init:system-provider')
      }

      const provider = providers.find((p) => p.status === 'active') || providers[0]
      const preferredModel = provider.models.find((m) => m.modelId.includes('sonnet'))
      const modelToUse = preferredModel || provider.models[0]

      if (!modelToUse) {
        throw new Error('No models available in system provider')
      }

      const secrets = await providerService.getProviderSecrets(SYSTEM_USER_ID, provider.providerId)
      if (!secrets || !secrets.apiKey) {
        throw new Error(`Failed to decrypt secrets for provider ${provider.providerId}`)
      }

      console.log(
        `[agent.generate-profile] Generating profile using ${modelToUse.modelId} (${provider.providerType})`,
      )

      const llmClient = await LLMClientFactory.create({
        provider: provider.providerType as any,
        anthropic:
          provider.providerType === 'anthropic'
            ? { apiKey: secrets.apiKey, model: modelToUse.modelString, maxTokens: 1024 }
            : undefined,
        openai:
          provider.providerType === 'openai'
            ? { apiKey: secrets.apiKey, model: modelToUse.modelString, maxTokens: 1024 }
            : undefined,
      })

      const prompt = buildGenerationPrompt(core, allExcludedNames)

      let fullResponse = ''
      await llmClient.streamMessage({
        messages: [
          {
            info: { id: '1', sessionID: 'gen', role: 'user', time: { created: Date.now() } },
            parts: [
              {
                id: '1',
                sessionID: 'gen',
                messageID: '1',
                type: 'text',
                text: prompt,
                time: { start: Date.now(), end: Date.now() },
              },
            ],
          },
        ],
        systemPrompt:
          'You are a creative assistant that generates unique AI assistant personas. Always respond with valid JSON only, no markdown or extra text.',
        callbacks: {
          onText: (chunk) => { fullResponse += chunk },
          onTextEnd: () => {},
          onToolCall: () => {},
        },
      })

      const profile = parseGeneratedProfile(fullResponse)
      console.log(`[agent.generate-profile] Generated profile: ${profile.fullName}`)

      return { profile }
    } catch (error: any) {
      console.error(`[agent.generate-profile] Failed to generate profile:`, error)
      throw new HandlerError('GENERATION_FAILED', error.message || 'Failed to generate agent profile')
    }
  }
}
