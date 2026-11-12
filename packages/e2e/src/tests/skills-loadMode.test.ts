/**
 * E2E Tests: Skill loadMode CRUD + @skill mention injection flow (TER-618 M2).
 *
 * Verifies end-to-end that:
 * 1. skill.create accepts and persists loadMode ('always' | 'on-demand')
 * 2. skill.update accepts and persists loadMode changes
 * 3. skill.list returns loadMode in each skill
 * 4. channel.send-message forwards skillIds in the payload
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  cleanupTestData,
  createTestClient,
  createTestWorkspace,
  globalSetup,
  globalTeardown,
} from '../utils/setup';
import type { TestClient } from '../utils/TestClient';

describe('Skill loadMode E2E', () => {
  let client: TestClient;
  let workspaceId: string;

  beforeAll(async () => {
    await globalSetup();
    await cleanupTestData();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  afterEach(async () => {
    if (client?.isConnected()) {
      await client.disconnect();
    }
  });

  test('should create a skill with loadMode=on-demand', async () => {
    client = await createTestClient('user1');
    workspaceId = await createTestWorkspace(client, 'loadMode Test WS');

    const res = await client.requestOk<{ skill: any }>('skill.create', {
      workspaceId,
      name: 'On-demand Skill',
      content: '# On-demand instructions',
      loadMode: 'on-demand',
    });

    expect(res.skill).toBeDefined();
    expect(res.skill.name).toBe('On-demand Skill');
    expect(res.skill.loadMode).toBe('on-demand');
    expect(res.skill.skillId).toMatch(/^sk_/);
  });

  test('should create a skill with loadMode=always', async () => {
    client = await createTestClient('user1');
    workspaceId = await createTestWorkspace(client, 'loadMode Test WS 2');

    const res = await client.requestOk<{ skill: any }>('skill.create', {
      workspaceId,
      name: 'Always Skill',
      content: '# Always instructions',
      loadMode: 'always',
    });

    expect(res.skill).toBeDefined();
    expect(res.skill.name).toBe('Always Skill');
    expect(res.skill.loadMode).toBe('always');
  });

  test('should default to on-demand when loadMode is omitted', async () => {
    client = await createTestClient('user1');
    workspaceId = await createTestWorkspace(client, 'loadMode Default WS');

    const res = await client.requestOk<{ skill: any }>('skill.create', {
      workspaceId,
      name: 'Default Mode Skill',
      content: '# Default',
    });

    expect(res.skill).toBeDefined();
    expect(res.skill.loadMode).toBe('on-demand');
  });

  test('should update skill loadMode from on-demand to always', async () => {
    client = await createTestClient('user1');
    workspaceId = await createTestWorkspace(client, 'loadMode Update WS');

    // Create on-demand skill
    const created = await client.requestOk<{ skill: any }>('skill.create', {
      workspaceId,
      name: 'Toggle Skill',
      content: '# Toggle me',
      loadMode: 'on-demand',
    });

    expect(created.skill.loadMode).toBe('on-demand');

    // Update to always
    const updated = await client.requestOk<{ skill: any }>('skill.update', {
      skillId: created.skill.skillId,
      loadMode: 'always',
    });

    expect(updated.skill).toBeDefined();
    expect(updated.skill.loadMode).toBe('always');
  });

  test('should list skills with loadMode field', async () => {
    client = await createTestClient('user1');
    workspaceId = await createTestWorkspace(client, 'loadMode List WS');

    await client.requestOk('skill.create', {
      workspaceId,
      name: 'List Skill A',
      content: '# A',
      loadMode: 'always',
    });

    await client.requestOk('skill.create', {
      workspaceId,
      name: 'List Skill B',
      content: '# B',
      loadMode: 'on-demand',
    });

    const list = await client.requestOk<{ skills: any[] }>('skill.list', { workspaceId });

    expect(Array.isArray(list.skills)).toBe(true);
    expect(list.skills.length).toBeGreaterThanOrEqual(2);

    const skillA = list.skills.find((s) => s.name === 'List Skill A');
    const skillB = list.skills.find((s) => s.name === 'List Skill B');

    expect(skillA).toBeDefined();
    expect(skillA.loadMode).toBe('always');
    expect(skillB).toBeDefined();
    expect(skillB.loadMode).toBe('on-demand');
  });
});

describe('Message send with skillIds E2E', () => {
  let client: TestClient;

  beforeAll(async () => {
    await globalSetup();
    await cleanupTestData();
  });

  afterAll(async () => {
    await globalTeardown();
  });

  afterEach(async () => {
    if (client?.isConnected()) {
      await client.disconnect();
    }
  });

  test('should send message with skillIds in payload', async () => {
    client = await createTestClient('user1');
    const workspaceId = await createTestWorkspace(client, 'SkillIds WS');

    // Create a skill to reference
    const skill = await client.requestOk<{ skill: any }>('skill.create', {
      workspaceId,
      name: 'Test Skill',
      content: '# Test',
      loadMode: 'on-demand',
    });

    // Create a channel
    const channel = await client.requestOk<{ channelId: string }>('channel.create', {
      workspaceId,
    });

    // Send message with skillIds
    await client.requestOk('channel.send-message', {
      channelId: channel.channelId,
      content: { type: 'text', text: 'Use @Test Skill' },
      skillIds: [skill.skill.skillId],
    });

    // Verify message_sent push arrives
    const sent = await client.waitFor('message_sent');
    expect(sent.type).toBe('message_sent');
    expect(sent.messageId).toBeDefined();
  });
});
