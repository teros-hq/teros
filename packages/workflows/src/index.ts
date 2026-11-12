/**
 * @teros/workflows — Visual workflow builder and execution engine
 *
 * Adapted from Flowing/HexaFlows into the Teros platform.
 * Leverages Teros's existing infrastructure: agents, MCAs, boards, tasks,
 * scheduler, and WebSocket.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 *
 * Phase 1 (current): MongoDB models + engine core
 * Phase 2: Action Bridge (Node → Task on board)
 * Phase 3: UI (FlowEditorWindow, FlowExecutionWindow, FlowLibraryWindow)
 * Phase 4: Triggers + Integrations
 * Phase 5: AI + Templates
 */

// Models (types, collections, indexes, ID generators)
export * from './models';

// Validator (gate validation: artifact schemas + legacy JSON Schema)
export * from './validator';

// Engine (workflow execution: startExecution, advanceExecution, getExecutionStatus)
export * from './engine';

// Bridge (board integration: BoardBridge interface + InMemoryBoardBridge)
// Handlers (node handlers: start, action, end, function, pin, integration)
export * from './handlers';
export * from './bridge';
