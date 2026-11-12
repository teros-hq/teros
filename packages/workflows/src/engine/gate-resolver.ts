/**
 * Gate Resolver
 *
 * Resolves input data for a node's input gates by following incoming edges
 * from upstream (completed) steps. Each edge carries data from a source node's
 * output gate to a target node's input gate.
 *
 * Also provides:
 * - Template interpolation: replaces {{variable}} placeholders in instructions
 *   with values extracted from input data
 * - Output data extraction: collects output gate data from a step's outputData
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Flow, WorkflowEdge, ExecutionStep, WorkflowNode, Gate } from '../models/types';
import { extractTemplateVariables } from '../validator/text-validator';

// ============================================================================
// INPUT GATE RESOLUTION
// ============================================================================

/**
 * Resolve input data for a node's input gates by following incoming edges.
 *
 * For each input gate, find the edge that targets it, then find the completed
 * step for the source node, and extract the output data from the source gate.
 *
 * Uses Flowing's edge naming: outputNodeId/outputId (source) → inputNodeId/inputId (target)
 *
 * @param node - The node whose input gates to resolve
 * @param flow - The flow (for edge lookup)
 * @param steps - All completed steps in the execution (to find source data)
 * @returns A map of gateId → data for the node's input gates
 */
export function resolveInputData(
  node: WorkflowNode,
  flow: Flow,
  steps: ExecutionStep[],
  branchId?: string,
): Record<string, unknown> {
  const inputData: Record<string, unknown> = {};

  // Find all edges that target this node (inputNodeId === node.nodeId)
  const incomingEdges = flow.edges.filter(
    (e: WorkflowEdge) => e.inputNodeId === node.nodeId,
  );

  // Build a lookup: nodeId → completed step
  // When branchId is provided, only match steps in the same branch.
  // When branchId is undefined (trunk path), only match steps with
  // undefined branchId (trunk steps), so branch data doesn't leak
  // into the trunk path.
  const stepByNodeId = new Map<string, ExecutionStep>();
  for (const step of steps) {
    if (step.status === 'completed') {
      // Branch-aware matching: same branchId or both trunk (undefined)
      if (step.branchId == null && branchId == null || step.branchId === branchId) {
        stepByNodeId.set(step.nodeId, step);
      }
    }
  }

  for (const edge of incomingEdges) {
    const sourceStep = stepByNodeId.get(edge.outputNodeId);
    if (!sourceStep || !sourceStep.outputData) continue;

    // Extract the data from the source gate (outputId)
    const sourceOutputData = sourceStep.outputData as Record<string, unknown>;
    const gateData = sourceOutputData[edge.outputId];
    inputData[edge.inputId] = gateData;
  }

  return inputData;
}

// ============================================================================
// TEMPLATE INTERPOLATION
// ============================================================================

/**
 * Interpolate {{variable}} placeholders in a template string using
 * values from the input data.
 *
 * Variables are resolved from the input data by:
 * 1. Looking at all input gates and their data
 * 2. For text gates: using extracted variables from the validated data
 * 3. For json gates: using the JSON object's fields
 *
 * In the Flowing model, gates reference artifacts via schemaId. The data
 * flowing through a gate is an object matching the artifact schema.
 * For interpolation, we extract fields from the object.
 *
 * @param template - The template string with {{variable}} placeholders
 * @param inputData - Input data map (gateId → data)
 * @param inputGates - The node's input gates (to know how to interpret data)
 * @returns The interpolated string
 */
export function interpolateTemplate(
  template: string,
  inputData: Record<string, unknown>,
  inputGates: Gate[],
): string {
  const variables = extractTemplateVariables(template);
  if (variables.length === 0) return template;

  // Build a variable lookup from input data
  const varMap: Record<string, string> = {};

  for (const gate of inputGates) {
    const data = inputData[gate.gateId];
    if (data === undefined || data === null) continue;

    if (typeof data === 'string') {
      // String data — use as value for any matching template variable
      for (const v of variables) {
        if (!varMap[v]) varMap[v] = data;
      }
    } else if (typeof data === 'object') {
      // Object data (artifact-typed) — use the object's fields
      const obj = data as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' || typeof value === 'number') {
          varMap[key] = String(value);
        }
      }
    }
  }

  // Replace placeholders
  let result = template;
  for (const varName of variables) {
    const value = varMap[varName];
    if (value !== undefined) {
      result = result.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value);
    }
  }

  return result;
}

// ============================================================================
// OUTPUT DATA EXTRACTION
// ============================================================================

/**
 * Extract output data from a task's outputData field, keyed by the node's
 * output gate IDs.
 *
 * For action nodes, the task produces output data. This function maps the
 * raw output to the node's output gates:
 * - If the node has a single output gate, the entire output is assigned to it
 * - If the node has multiple output gates, the output is expected to be an
 *   object keyed by gateId
 *
 * @param node - The node that produced the output
 * @param rawOutput - The raw output data from the task
 * @returns A map of gateId → output data
 */
export function extractOutputData(
  node: WorkflowNode,
  rawOutput: unknown,
): Record<string, unknown> {
  if (node.outputs.length === 0) {
    return {};
  }

  // If rawOutput is already an object keyed by gateId(s), return as-is.
  // This handles the case where workflowOutputData is stored as
  // { gate_xxx: { ...data } } — which is the standard format.
  if (typeof rawOutput === 'object' && rawOutput !== null && !Array.isArray(rawOutput)) {
    const obj = rawOutput as Record<string, unknown>;
    const hasGateKeys = node.outputs.some(g => g.gateId in obj);
    if (hasGateKeys) {
      return obj;
    }
  }

  if (node.outputs.length === 1) {
    return { [node.outputs[0].gateId]: rawOutput };
  }

  // Multiple output gates: expect an object keyed by gateId
  if (typeof rawOutput === 'object' && rawOutput !== null && !Array.isArray(rawOutput)) {
    return rawOutput as Record<string, unknown>;
  }

  // Fallback: assign to first gate
  return { [node.outputs[0].gateId]: rawOutput };
}
