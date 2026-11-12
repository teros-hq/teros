/**
 * Tests for WorkflowTaskExtensions — verifying the fields that extend
 * the existing Task model are correctly typed and structured.
 */

import { describe, expect, it } from 'bun:test';

import {
  generateGateId,
  generateExecutionId,
  generateNodeId,
  type WorkflowTaskExtensions,
  type Gate,
} from '../src/models/index';

describe('WorkflowTaskExtensions', () => {
  it('all fields set — complete workflow task', () => {
    const ext: WorkflowTaskExtensions = {
      inputGate: {
        gateId: generateGateId(),
        schemaId: 'art_input123',
        label: 'Input Data',
        mode: 'passthrough',
      },
      outputGate: {
        gateId: generateGateId(),
        schemaId: 'art_output123',
        label: 'Report Output',
        mode: 'create',
      },
      inputData: { topic: 'AI trends 2026' },
      outputData: 'This report covers AI trends in 2026...',
      workflowExecutionId: generateExecutionId(),
      workflowNodeId: generateNodeId(),
    };

    expect(ext.inputGate).toBeDefined();
    expect(ext.outputGate).toBeDefined();
    expect(ext.inputData).toBeDefined();
    expect(ext.outputData).toBeDefined();
    expect(ext.workflowExecutionId).toStartWith('exec_');
    expect(ext.workflowNodeId).toStartWith('node_');
  });

  it('all fields optional — plain task without workflow context', () => {
    const ext: WorkflowTaskExtensions = {};
    expect(ext.inputGate).toBeUndefined();
    expect(ext.outputGate).toBeUndefined();
    expect(ext.inputData).toBeUndefined();
    expect(ext.outputData).toBeUndefined();
    expect(ext.workflowExecutionId).toBeUndefined();
    expect(ext.workflowNodeId).toBeUndefined();
  });

  it('only execution refs set — task created by workflow but no gate data yet', () => {
    const ext: WorkflowTaskExtensions = {
      workflowExecutionId: generateExecutionId(),
      workflowNodeId: generateNodeId(),
    };

    expect(ext.workflowExecutionId).toStartWith('exec_');
    expect(ext.workflowNodeId).toStartWith('node_');
    expect(ext.inputGate).toBeUndefined();
    expect(ext.outputData).toBeUndefined();
  });

  it('signal-only gate as inputGate', () => {
    const signalGate: Gate = {
      gateId: generateGateId(),
      schemaId: null,
    };

    const ext: WorkflowTaskExtensions = {
      inputGate: signalGate,
    };

    expect(ext.inputGate!.schemaId).toBeNull();
  });

  it('artifact-referencing gate as outputGate', () => {
    const artifactGate: Gate = {
      gateId: generateGateId(),
      schemaId: 'art_report123',
      label: 'Structured Result',
      mode: 'create',
    };

    const ext: WorkflowTaskExtensions = {
      outputGate: artifactGate,
      outputData: { summary: 'Task completed', score: 95 },
    };

    expect(ext.outputGate!.schemaId).toBe('art_report123');
    expect(ext.outputGate!.mode).toBe('create');
  });

  it('inputData can be any type — object, string, array', () => {
    const extWithObject: WorkflowTaskExtensions = { inputData: { key: 'value', nested: { deep: true } } };
    expect(extWithObject.inputData).toEqual({ key: 'value', nested: { deep: true } });

    const extWithString: WorkflowTaskExtensions = { inputData: 'plain text input' };
    expect(extWithString.inputData).toBe('plain text input');

    const extWithArray: WorkflowTaskExtensions = { inputData: [1, 2, 3] };
    expect(extWithArray.inputData).toEqual([1, 2, 3]);
  });

  it('execution and node IDs use correct prefixes', () => {
    const ext: WorkflowTaskExtensions = {
      workflowExecutionId: 'exec_abc123def456',
      workflowNodeId: 'node_xyz789ghi012',
    };

    expect(ext.workflowExecutionId).toStartWith('exec_');
    expect(ext.workflowNodeId).toStartWith('node_');
  });
});

describe('WorkflowTaskExtensions — backward compatibility', () => {
  it('a Task without workflow fields is still valid (all fields optional)', () => {
    const plainTask = {
      taskId: 'task_abc123',
      title: 'Manual task',
      description: 'A task created manually',
      priority: 'medium' as const,
      archived: false,
      tags: [],
      running: false,
      dependencies: [],
      progressNotes: [],
      activity: [],
      createdBy: 'user_test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(plainTask).not.toHaveProperty('workflowInputGate');
    expect(plainTask).not.toHaveProperty('workflowOutputGate');
    expect(plainTask).not.toHaveProperty('workflowExecutionId');
    expect(plainTask).not.toHaveProperty('workflowNodeId');
  });

  it('a Task with workflow fields has them alongside regular fields', () => {
    const workflowTask = {
      taskId: 'task_def456',
      title: 'Generate report',
      description: 'Workflow-generated task',
      priority: 'high' as const,
      archived: false,
      tags: ['workflows', 'phase-1'],
      running: false,
      dependencies: [],
      progressNotes: [],
      activity: [],
      createdBy: 'agent_workflow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Workflow extensions
      workflowInputGate: {
        gateId: generateGateId(),
        schemaId: 'art_input123',
        label: 'Input',
        mode: 'passthrough',
      },
      workflowOutputGate: {
        gateId: generateGateId(),
        schemaId: 'art_output123',
        label: 'Output',
        mode: 'create',
      },
      input: { schemaId: null, data: { topic: 'AI trends' } },
      workflowExecutionId: generateExecutionId(),
      workflowNodeId: generateNodeId(),
    };

    expect(workflowTask.workflowInputGate).toBeDefined();
    expect(workflowTask.workflowOutputGate).toBeDefined();
    expect(workflowTask.input?.data).toEqual({ topic: 'AI trends' });
    expect(workflowTask.workflowExecutionId).toStartWith('exec_');
    expect(workflowTask.workflowNodeId).toStartWith('node_');
    expect(workflowTask.taskId).toBe('task_def456');
    expect(workflowTask.title).toBe('Generate report');
  });
});
