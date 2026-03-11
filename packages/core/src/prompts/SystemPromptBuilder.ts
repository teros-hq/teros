/**
 * System Prompt Builder
 *
 * Combines base system prompt (abstract, common to all agents)
 * with agent-specific configuration (identity, purpose, constraints).
 *
 * This allows:
 * - Base prompt to be reusable across all agents (Alice, Iria, Aurelia, etc.)
 * - Agent personality/constraints to be configured via agent-config.yaml
 * - Environment info to be injected dynamically
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadCustomRules } from './custom-rules-loader';
import { generateProjectTree } from './tree-generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface AgentConfig {
  identity: {
    name: string;
    role: string;
    email: string;
  };
  purpose: string;
  personality?: string[];
  context: {
    user: {
      name: string;
      email: string;
      personal_email?: string;
      work_email?: string;
    };
    communication: {
      method: string;
      send_images_via?: string;
    };
    environment: {
      type: string;
      mode: string;
      platform: string;
      working_directory: string;
      workspace_directory: string;
      workspace_usage?: string;
    };
  };
  constraints?: {
    production?: string[];
    git?: string[];
    browser_automation?: string[];
  };
  repositories?: Record<
    string,
    {
      type: string;
      examples?: string[];
    }
  >;
}

export interface EnvironmentInfo {
  workingDirectory: string;
  platform: string;
  date: string;
  modelName?: string;
  modelId?: string;
  includeProjectTree?: boolean;
  projectTreeLimit?: number;
  includeCustomRules?: boolean;
  gitRepo?: boolean;
  memoryContext?: string; // Pre-built memory context to include
}

export class SystemPromptBuilder {
  private basePrompt: string;

  constructor(basePromptPath?: string) {
    // Load base prompt from file
    const promptPath = basePromptPath || join(__dirname, '../../prompts/base-system-prompt.txt');
    this.basePrompt = readFileSync(promptPath, 'utf-8');
  }

  /**
   * Build complete system prompt from base + agent config + environment
   */
  async build(agentConfig: AgentConfig, env: EnvironmentInfo): Promise<string> {
    const sections: string[] = [];

    // 1. Agent Identity & Purpose
    sections.push(this.buildIdentitySection(agentConfig));

    // 2. Environment Context (includes project tree if enabled)
    sections.push(await this.buildEnvironmentSection(agentConfig, env));

    // 3. Constraints (if any)
    if (agentConfig.constraints) {
      sections.push(this.buildConstraintsSection(agentConfig.constraints));
    }

    // 4. Base Prompt (tone, style, security, task management, etc.)
    sections.push(this.basePrompt);

    // 5. Repositories (if any)
    if (agentConfig.repositories) {
      sections.push(this.buildRepositoriesSection(agentConfig.repositories));
    }

    // 6. Custom Rules (AGENTS.md files, if enabled)
    if (env.includeCustomRules !== false) {
      const customRules = await this.buildCustomRulesSection(env.workingDirectory);
      if (customRules) {
        sections.push(customRules);
      }
    }

    // 7. Memory Context (if provided)
    if (env.memoryContext) {
      sections.push(env.memoryContext);
    }

    return sections.join('\n\n');
  }

  private buildIdentitySection(config: AgentConfig): string {
    const lines: string[] = [];

    // Opening statement with name and purpose
    lines.push(`I'm ${config.identity.name}, ${config.purpose}`);
    lines.push('');

    // Identity details
    lines.push('# Identity');
    lines.push(`- Name: ${config.identity.name}`);
    lines.push(`- Email: ${config.identity.email}`);
    lines.push(`- Role: ${config.identity.role}`);

    // User info
    if (config.context.user) {
      lines.push(`- User: ${config.context.user.name} (${config.context.user.email})`);
    }

    // Communication method
    if (config.context.communication) {
      lines.push(`- Communication: ${config.context.communication.method}`);
      if (config.context.communication.send_images_via) {
        lines.push(`- Send images via: ${config.context.communication.send_images_via}`);
      }
    }

    // Personality traits
    if (config.personality && config.personality.length > 0) {
      lines.push('');
      lines.push('# Personality');
      for (const trait of config.personality) {
        lines.push(`- ${trait}`);
      }
    }

    return lines.join('\n');
  }

  private async buildEnvironmentSection(
    config: AgentConfig,
    env: EnvironmentInfo,
  ): Promise<string> {
    const lines: string[] = [];

    lines.push('# Environment');
    lines.push(`Working directory: ${env.workingDirectory}`);
    lines.push(`Is directory a git repo: ${env.gitRepo ? 'yes' : 'no'}`);

    if (config.context.environment.workspace_directory) {
      lines.push(`Workspace directory: ${config.context.environment.workspace_directory}`);
      if (config.context.environment.workspace_usage) {
        lines.push(`Workspace usage: ${config.context.environment.workspace_usage}`);
      }
    }

    lines.push(`Platform: ${env.platform}`);
    lines.push(`Environment type: ${config.context.environment.type}`);
    lines.push(`Today's date: ${env.date}`);

    if (env.modelName) {
      lines.push('');
      lines.push(
        `You are powered by the model named ${env.modelName}.${env.modelId ? ` The exact model ID is ${env.modelId}.` : ''}`,
      );
    }

    // Add project tree if enabled and in a git repo
    if (env.includeProjectTree !== false && env.gitRepo) {
      try {
        const projectTree = await generateProjectTree({
          cwd: env.workingDirectory,
          limit: env.projectTreeLimit || 200,
        });

        if (projectTree) {
          lines.push('');
          lines.push('<files>');
          lines.push(projectTree);
          lines.push('</files>');
        }
      } catch (error) {
        // Silently skip if tree generation fails
        console.warn('Failed to generate project tree:', error);
      }
    }

    return lines.join('\n');
  }

  private buildConstraintsSection(constraints: AgentConfig['constraints']): string {
    const lines: string[] = [];

    lines.push('# Constraints');

    if (constraints?.production && constraints.production.length > 0) {
      lines.push('');
      lines.push('## Production Environment');
      for (const constraint of constraints.production) {
        lines.push(`- ${constraint}`);
      }
    }

    if (constraints?.git && constraints.git.length > 0) {
      lines.push('');
      lines.push('## Git Workflow');
      for (const constraint of constraints.git) {
        lines.push(`- ${constraint}`);
      }
    }

    if (constraints?.browser_automation && constraints.browser_automation.length > 0) {
      lines.push('');
      lines.push('## Browser Automation');
      for (const constraint of constraints.browser_automation) {
        lines.push(`- ${constraint}`);
      }
    }

    return lines.join('\n');
  }

  private buildRepositoriesSection(repositories: AgentConfig['repositories']): string {
    const lines: string[] = [];

    if (!repositories) return '';

    lines.push('# Repositories');

    for (const [org, info] of Object.entries(repositories)) {
      lines.push(
        `- **${org}**: ${info.type} projects${info.examples ? ` (${info.examples.join(', ')})` : ''}`,
      );
    }

    return lines.join('\n');
  }

  private async buildCustomRulesSection(workingDirectory: string): Promise<string | null> {
    try {
      // Load custom rules (currently just returns empty string)
      const rules = await loadCustomRules();

      if (!rules || rules.length === 0) return null;

      // Return the custom rules string
      return rules;
    } catch (error) {
      console.warn('Failed to load custom rules:', error);
      return null;
    }
  }
}
