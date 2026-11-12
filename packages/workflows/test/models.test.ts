/**
 * Tests for workflow models — types, ID generators, and structure validation.
 *
 * These tests verify:
 * 1. ID generators produce correctly prefixed IDs
 * 2. Type structures are correct (compile-time + runtime sanity)
 * 3. Gate structure with schemaId (Flowing model)
 * 4. Artifact model structure
 * 5. Flow/Execution/ExecutionStep document shapes
 */

import { describe, expect, it } from 'bun:test';

import {
  generateFlowId,
  generateExecutionId,
  generateStepId,
  generateNodeId,
  generateEdgeId,
  generateGateId,
  generateTriggerId,
  generateArtifactId,
  type Flow,
  type Execution,
  type ExecutionStep,
  type Gate,
  type WorkflowNode,
  type WorkflowEdge,
  type Trigger,
  type NodeType,
  type FlowStatus,
  type ExecutionStatus,
  type ExecutionStepStatus,
  type TriggerType,
  type WorkflowTaskExtensions,
  type Artifact,
  type ArtifactScope,
  type ArtifactSchema,
  type FieldType,
  type FieldOption,
  type GateMode,
} from '../src/models/index';

// ============================================================================
// ID GENERATORS
// ============================================================================

describe('ID generators', () => {
  it('generateFlowId produces flow_ prefix', () => {
    const id = generateFlowId();
    expect(id).toStartWith('flow_');
    expect(id.length).toBeGreaterThan('flow_'.length);
  });

  it('generateExecutionId produces exec_ prefix', () => {
    const id = generateExecutionId();
    expect(id).toStartWith('exec_');
    expect(id.length).toBeGreaterThan('exec_'.length);
  });

  it('generateStepId produces step_ prefix', () => {
    const id = generateStepId();
    expect(id).toStartWith('step_');
    expect(id.length).toBeGreaterThan('step_'.length);
  });

  it('generateNodeId produces node_ prefix', () => {
    const id = generateNodeId();
    expect(id).toStartWith('node_');
    expect(id.length).toBeGreaterThan('node_'.length);
  });

  it('generateEdgeId produces edge_ prefix', () => {
    const id = generateEdgeId();
    expect(id).toStartWith('edge_');
    expect(id.length).toBeGreaterThan('edge_'.length);
  });

  it('generateGateId produces gate_ prefix', () => {
    const id = generateGateId();
    expect(id).toStartWith('gate_');
    expect(id.length).toBeGreaterThan('gate_'.length);
  });

  it('generateTriggerId produces trig_ prefix', () => {
    const id = generateTriggerId();
    expect(id).toStartWith('trig_');
    expect(id.length).toBeGreaterThan('trig_'.length);
  });

  it('generateArtifactId produces art_ prefix', () => {
    const id = generateArtifactId();
    expect(id).toStartWith('art_');
    expect(id.length).toBeGreaterThan('art_'.length);
  });

  it('each generator produces unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateFlowId());
    }
    expect(ids.size).toBe(100);
  });
});

// ============================================================================
// TYPE STRUCTURE — runtime sanity checks
// ============================================================================

describe('Type structures', () => {
  it('Gate: artifact-referencing gate has schemaId', () => {
    const gate: Gate = {
      gateId: generateGateId(),
      schemaId: 'art_lead123',
      label: 'Lead Input',
      mode: 'passthrough',
    };
    expect(gate.schemaId).toBe('art_lead123');
    expect(gate.label).toBe('Lead Input');
    expect(gate.mode).toBe('passthrough');
  });

  it('Gate: signal-only gate has schemaId null', () => {
    const gate: Gate = {
      gateId: generateGateId(),
      schemaId: null,
    };
    expect(gate.schemaId).toBeNull();
    expect(gate.label).toBeUndefined();
  });

  it('Gate: allowModifying flag for input gates', () => {
    const gate: Gate = {
      gateId: generateGateId(),
      schemaId: 'art_lead123',
      label: 'Lead Input',
      mode: 'passthrough',
      allowModifying: true,
    };
    expect(gate.allowModifying).toBe(true);
  });

  it('Artifact: complete artifact document', () => {
    const artifact: Artifact = {
      artifactId: generateArtifactId(),
      source: 'global',
      name: 'Lead',
      title: 'Lead',
      description: 'A sales lead',
      color: '#FF5733',
      icon: '🎯',
      schema: {
        name: 'Lead',
        title: 'Lead',
        type: 'object',
        properties: {
          name: { name: 'name', type: 'text', required: true },
          email: { name: 'email', type: 'text', required: true },
          company: { name: 'company', type: 'text' },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(artifact.artifactId).toStartWith('art_');
    expect(artifact.source).toBe('global');
    expect(artifact.schema.properties.name.required).toBe(true);
    expect(artifact.schema.properties.company.required).toBeUndefined();
  });

  it('Artifact: workspace-scoped artifact', () => {
    const artifact: Artifact = {
      artifactId: generateArtifactId(),
      workspaceId: 'work_test123',
      source: 'workspace',
      name: 'Custom Report',
      title: 'Custom Report',
      description: 'Workspace-specific report type',
      color: '#3B82F6',
      icon: '📊',
      schema: {
        name: 'Custom Report',
        title: 'Custom Report',
        type: 'object',
        properties: {
          title: { name: 'title', type: 'text', required: true },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(artifact.workspaceId).toBe('work_test123');
    expect(artifact.source).toBe('workspace');
  });

  it('WorkflowNode: action node with inputs and outputs', () => {
    const node: WorkflowNode = {
      nodeId: generateNodeId(),
      type: 'action',
      label: 'Generate Report',
      description: 'Generates a report from input data',
      instructions: 'Create a report based on the provided data.',
      role: 'agent:alice',
      color: '#3B82F6',
      direction: 'right',
      inputs: [
        {
          gateId: generateGateId(),
          schemaId: 'art_data123',
          label: 'Data Input',
          mode: 'passthrough',
        },
      ],
      outputs: [
        {
          gateId: generateGateId(),
          schemaId: 'art_report123',
          label: 'Report Output',
          mode: 'create',
        },
      ],
      position: { x: 100, y: 200 },
    };
    expect(node.type).toBe('action');
    expect(node.inputs).toHaveLength(1);
    expect(node.outputs).toHaveLength(1);
    expect(node.role).toBe('agent:alice');
    expect(node.color).toBe('#3B82F6');
    expect(node.direction).toBe('right');
  });

  it('WorkflowNode: start node with no gates', () => {
    const node: WorkflowNode = {
      nodeId: generateNodeId(),
      type: 'start',
      label: 'Start',
      description: 'Entry point',
      instructions: '',
      role: '',
      color: '#10B981',
      direction: 'right',
      inputs: [],
      outputs: [],
      position: { x: 0, y: 0 },
    };
    expect(node.type).toBe('start');
    expect(node.inputs).toHaveLength(0);
  });

  it('WorkflowNode: function node with data config', () => {
    const node: WorkflowNode = {
      nodeId: generateNodeId(),
      type: 'function',
      label: 'Transform Data',
      description: 'Transforms input data',
      instructions: '',
      role: '',
      color: '#F59E0B',
      direction: 'right',
      inputs: [
        { gateId: generateGateId(), schemaId: 'art_input123' },
      ],
      outputs: [
        { gateId: generateGateId(), schemaId: 'art_output123' },
      ],
      position: { x: 200, y: 100 },
      data: { code: 'return data.toUpperCase();' },
    };
    expect(node.type).toBe('function');
    expect(node.data).toBeDefined();
    expect(node.data!.code).toBe('return data.toUpperCase();');
  });

  it('WorkflowEdge: connects output gate to input gate (Flowing naming)', () => {
    const edge: WorkflowEdge = {
      edgeId: generateEdgeId(),
      flowId: 'flow_abc123',
      label: 'data flow',
      outputNodeId: 'node_abc',
      outputId: 'gate_out_1',
      inputNodeId: 'node_def',
      inputId: 'gate_in_1',
    };
    expect(edge.outputNodeId).toBe('node_abc');
    expect(edge.inputNodeId).toBe('node_def');
    expect(edge.outputId).toBe('gate_out_1');
    expect(edge.inputId).toBe('gate_in_1');
    expect(edge.flowId).toBe('flow_abc123');
    expect(edge.label).toBe('data flow');
  });

  it('Trigger: manual trigger with empty config', () => {
    const trigger: Trigger = {
      triggerId: generateTriggerId(),
      type: 'manual',
      config: {},
    };
    expect(trigger.type).toBe('manual');
    expect(Object.keys(trigger.config)).toHaveLength(0);
  });

  it('Trigger: schedule trigger with cron config', () => {
    const trigger: Trigger = {
      triggerId: generateTriggerId(),
      type: 'schedule',
      config: {
        cronExpression: '0 9 * * 1-5',
        timezone: 'Europe/Madrid',
      },
    };
    expect(trigger.type).toBe('schedule');
    expect(trigger.config.cronExpression).toBe('0 9 * * 1-5');
  });

  it('Flow: complete flow document', () => {
    const startNode: WorkflowNode = {
      nodeId: generateNodeId(),
      type: 'start',
      label: 'Start',
      description: 'Entry point',
      instructions: '',
      role: '',
      color: '#10B981',
      direction: 'right',
      inputs: [],
      outputs: [],
      position: { x: 0, y: 0 },
    };
    const endNode: WorkflowNode = {
      nodeId: generateNodeId(),
      type: 'end',
      label: 'End',
      description: 'Terminal node',
      instructions: '',
      role: '',
      color: '#EF4444',
      direction: 'right',
      inputs: [],
      outputs: [],
      position: { x: 400, y: 0 },
    };
    const edge: WorkflowEdge = {
      edgeId: generateEdgeId(),
      flowId: 'flow_test',
      outputNodeId: startNode.nodeId,
      outputId: 'gate_out_start',
      inputNodeId: endNode.nodeId,
      inputId: 'gate_in_end',
    };

    const flow: Flow = {
      flowId: generateFlowId(),
      workspaceId: 'work_test123',
      name: 'Simple Flow',
      description: 'A minimal flow with start → end',
      nodes: [startNode, endNode],
      edges: [edge],
      triggers: [
        {
          triggerId: generateTriggerId(),
          type: 'manual',
          config: {},
        },
      ],
      status: 'draft',
      createdBy: 'user_test',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(flow.flowId).toStartWith('flow_');
    expect(flow.nodes).toHaveLength(2);
    expect(flow.edges).toHaveLength(1);
    expect(flow.triggers).toHaveLength(1);
    expect(flow.status).toBe('draft');
  });

  it('Execution: running execution document', () => {
    const exec: Execution = {
      executionId: generateExecutionId(),
      flowId: 'flow_abc123',
      workspaceId: 'work_test123',
      status: 'running',
      triggeredBy: 'manual',
      currentNodes: ['node_start', 'node_action1'],
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(exec.status).toBe('running');
    expect(exec.currentNodes).toHaveLength(2);
    expect(exec.triggeredBy).toBe('manual');
    expect(exec.completedAt).toBeUndefined();
  });

  it('Execution: completed execution with completedAt', () => {
    const exec: Execution = {
      executionId: generateExecutionId(),
      flowId: 'flow_abc123',
      workspaceId: 'work_test123',
      status: 'completed',
      triggeredBy: 'schedule',
      currentNodes: [],
      startedAt: new Date('2026-08-31T10:00:00Z'),
      completedAt: new Date('2026-08-31T10:05:00Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(exec.status).toBe('completed');
    expect(exec.currentNodes).toHaveLength(0);
    expect(exec.completedAt).toBeDefined();
  });

  it('ExecutionStep: running step with task reference and schema IDs', () => {
    const step: ExecutionStep = {
      stepId: generateStepId(),
      executionId: 'exec_abc123',
      flowId: 'flow_xyz789',
      workspaceId: 'work_test123',
      nodeId: 'node_action1',
      taskId: 'task_42a57945',
      status: 'running',
      inputData: { gate_in_1: { topic: 'AI trends' } },
      inputSchemaId: 'art_input123',
      outputSchemaId: 'art_output123',
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(step.status).toBe('running');
    expect(step.taskId).toBeDefined();
    expect(step.inputData).toBeDefined();
    expect(step.inputSchemaId).toBe('art_input123');
    expect(step.outputSchemaId).toBe('art_output123');
  });

  it('ExecutionStep: retry status with retry info', () => {
    const step: ExecutionStep = {
      stepId: generateStepId(),
      executionId: 'exec_abc123',
      flowId: 'flow_xyz789',
      workspaceId: 'work_test123',
      nodeId: 'node_function1',
      status: 'retry',
      retryAttempts: 3,
      nextRetryAt: new Date('2026-08-31T11:00:00Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(step.status).toBe('retry');
    expect(step.retryAttempts).toBe(3);
    expect(step.nextRetryAt).toBeDefined();
  });

  it('ExecutionStep: completed step with output data', () => {
    const step: ExecutionStep = {
      stepId: generateStepId(),
      executionId: 'exec_abc123',
      flowId: 'flow_xyz789',
      workspaceId: 'work_test123',
      nodeId: 'node_action1',
      taskId: 'task_42a57945',
      status: 'completed',
      inputData: { gate_in_1: { topic: 'AI trends' } },
      outputData: { gate_out_1: 'Report on AI trends...' },
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(step.status).toBe('completed');
    expect(step.outputData).toBeDefined();
    expect(step.completedAt).toBeDefined();
  });

  it('ExecutionStep: step without taskId (non-action node)', () => {
    const step: ExecutionStep = {
      stepId: generateStepId(),
      executionId: 'exec_abc123',
      flowId: 'flow_xyz789',
      workspaceId: 'work_test123',
      nodeId: 'node_start',
      status: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(step.taskId).toBeUndefined();
    expect(step.status).toBe('completed');
  });

  it('WorkflowTaskExtensions: all fields set', () => {
    const ext: WorkflowTaskExtensions = {
      inputGate: {
        gateId: generateGateId(),
        schemaId: 'art_input123',
        label: 'Input',
        mode: 'passthrough',
      },
      outputGate: {
        gateId: generateGateId(),
        schemaId: 'art_output123',
        label: 'Output',
        mode: 'create',
      },
      inputData: { key: 'value' },
      outputData: 'The deliverable text',
      workflowExecutionId: 'exec_abc123',
      workflowNodeId: 'node_action1',
    };
    expect(ext.inputGate).toBeDefined();
    expect(ext.outputGate).toBeDefined();
    expect(ext.workflowExecutionId).toBe('exec_abc123');
  });
});

// ============================================================================
// TYPE COMPATIBILITY — ensure union types accept valid values
// ============================================================================

describe('Type unions', () => {
  it('NodeType accepts all 6 Flowing values', () => {
    const types: NodeType[] = ['start', 'action', 'end', 'function', 'pin', 'integration'];
    expect(types).toHaveLength(6);
  });

  it('FlowStatus accepts all valid values', () => {
    const statuses: FlowStatus[] = ['draft', 'active', 'archived'];
    expect(statuses).toHaveLength(3);
  });

  it('ExecutionStatus accepts all valid values', () => {
    const statuses: ExecutionStatus[] = ['running', 'completed', 'failed', 'paused'];
    expect(statuses).toHaveLength(4);
  });

  it('ExecutionStepStatus accepts all valid values including retry', () => {
    const statuses: ExecutionStepStatus[] = ['pending', 'running', 'completed', 'failed', 'blocked', 'retry'];
    expect(statuses).toHaveLength(6);
  });

  it('TriggerType accepts all valid values', () => {
    const types: TriggerType[] = ['manual', 'schedule', 'webhook', 'event'];
    expect(types).toHaveLength(4);
  });

  it('ArtifactScope accepts all valid values', () => {
    const scopes: ArtifactScope[] = ['global', 'workspace', 'flow'];
    expect(scopes).toHaveLength(3);
  });

  it('GateMode accepts all valid values', () => {
    const modes: GateMode[] = ['passthrough', 'find', 'create'];
    expect(modes).toHaveLength(3);
  });

  it('FieldType accepts all 9 User Forms values', () => {
    const types: FieldType[] = ['text', 'textarea', 'number', 'select', 'checkbox', 'radio', 'date', 'time', 'datetime'];
    expect(types).toHaveLength(9);
  });

  it('FieldOption has value and label', () => {
    const opt: FieldOption = { value: 'draft', label: 'Draft' };
    expect(opt.value).toBe('draft');
    expect(opt.label).toBe('Draft');
  });
});

// ============================================================================
// ARTIFACT PROPERTY UI METADATA (R3 — label, placeholder, defaultValue, hint, format)
// ============================================================================

describe('ArtifactProperty UI metadata (R3)', () => {
  it('Artifact: property with label, placeholder, defaultValue, hint, format', () => {
    const artifact: Artifact = {
      artifactId: generateArtifactId(),
      source: 'workspace',
      name: 'Email',
      title: 'Email',
      description: 'An email artifact with UI metadata',
      color: '#8B5CF6',
      icon: '📧',
      schema: {
        name: 'Email',
        title: 'Email',
        type: 'object',
        properties: {
          to: {
            name: 'to',
            type: 'text',
            required: true,
            label: 'Destinatario',
            placeholder: 'destinatario@email.com',
            pattern: '^[^@]+@[^@]+\\\\.[^@]+$',
            hint: 'Email del destinatario principal',
          },
          subject: {
            name: 'subject',
            type: 'text',
            required: true,
            label: 'Asunto',
            placeholder: 'Asunto del email',
            hint: 'Línea de asunto del email',
          },
          body: {
            name: 'body',
            type: 'textarea',
            required: true,
            label: 'Contenido',
            placeholder: 'Escribe el contenido del email...',
            hint: 'Contenido del email en markdown',
            defaultValue: 'Hola,\n\n',
          },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(artifact.schema.properties.to.label).toBe('Destinatario');
    expect(artifact.schema.properties.to.placeholder).toBe('destinatario@email.com');
    expect(artifact.schema.properties.to.pattern).toBe('^[^@]+@[^@]+\\\\.[^@]+$');
    expect(artifact.schema.properties.to.hint).toBe('Email del destinatario principal');
    expect(artifact.schema.properties.body.defaultValue).toBe('Hola,\n\n');
    expect(artifact.schema.properties.body.type).toBe('textarea');
  });

  it('Artifact: properties without UI metadata still work (backwards compat)', () => {
    const artifact: Artifact = {
      artifactId: generateArtifactId(),
      source: 'global',
      name: 'Lead',
      title: 'Lead',
      description: 'A sales lead',
      color: '#FF5733',
      icon: '🎯',
      schema: {
        name: 'Lead',
        title: 'Lead',
        type: 'object',
        properties: {
          name: { name: 'name', type: 'text', required: true },
          email: { name: 'email', type: 'text', required: true },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(artifact.schema.properties.name.label).toBeUndefined();
    expect(artifact.schema.properties.name.placeholder).toBeUndefined();
    expect(artifact.schema.properties.name.defaultValue).toBeUndefined();
    expect(artifact.schema.properties.name.hint).toBeUndefined();
    expect(artifact.schema.properties.name.pattern).toBeUndefined();
  });

  it('Artifact: defaultValue can be a non-string type', () => {
    const artifact: Artifact = {
      artifactId: generateArtifactId(),
      source: 'workspace',
      name: 'Config',
      title: 'Config',
      description: 'Configuration with default values',
      color: '#3B82F6',
      icon: '⚙️',
      schema: {
        name: 'Config',
        title: 'Config',
        type: 'object',
        properties: {
          enabled: {
            name: 'enabled',
            type: 'checkbox',
            defaultValue: true,
          },
          port: {
            name: 'port',
            type: 'number',
            defaultValue: 8080,
          },
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(artifact.schema.properties.enabled.defaultValue).toBe(true);
    expect(artifact.schema.properties.port.defaultValue).toBe(8080);
  });
});
