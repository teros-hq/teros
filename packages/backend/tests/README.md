# Teros Backend Tests

Tests de comportamiento (BDD) para el backend WebSocket API de Teros.

## Estructura

```
tests/
├── TestServer.ts              # Servidor de pruebas con mocking
├── e2e.test.ts               # Tests E2E generales
├── tool-execution.test.ts    # Tests específicos de tool execution
└── README.md                 # Este archivo
```

## Tool Execution Tests

El archivo `tool-execution.test.ts` contiene tests específicos para verificar el flujo completo de ejecución de herramientas:

### Qué se verifica:

1. **Eventos de streaming en tiempo real**:
   - `message_chunk` con `chunkType: 'tool_call_start'`
   - `message_chunk` con `chunkType: 'tool_call_complete'`
   - Orden correcto de eventos

2. **Persistencia en base de datos**:
   - Mensajes con `content.type: 'tool_execution'`
   - Campos correctos: `toolCallId`, `toolName`, `input`, `status`, `output`, `error`, `duration`
   - Status: `completed` o `failed`

3. **Flujo completo**:
   - User envía mensaje
   - Agent recibe mensaje
   - Typing indicators (start/stop)
   - Tool execution (start/complete chunks)
   - Agent responde con resultado
   - Todo se guarda en BD

### Tests incluidos:

- ✅ `should execute tool and persist tool_execution content` - Flujo completo básico
- ✅ `should handle multiple tool calls in sequence` - Múltiples herramientas
- ✅ `should handle tool execution failure` - Manejo de errores
- ✅ `should maintain correct event order` - Orden de eventos
- ✅ `should work gracefully when agent does not request tools` - Sin herramientas

## Ejecutar los tests

```bash
# Todos los tests
bun test

# Solo tests E2E
bun test packages/backend/tests/e2e.test.ts

# Solo tests de tool execution
bun test packages/backend/tests/tool-execution.test.ts

# Watch mode
bun test --watch
```

## Configuración

Los tests requieren:

1. **MongoDB** en ejecución (local o remoto)
2. **Variables de entorno** en `.env.test`:

```bash
# .env.test (packages/backend/.env.test)
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=teros_test
```

## Mocking

### Mock LLM Responses

El `TestServer` permite configurar respuestas mockeadas del LLM:

```typescript
const server = await createTestServer({
  mockResponses: [
    {
      text: 'Let me check that for you.',
      toolCalls: [
        {
          id: 'tool_call_001',
          name: 'bash',
          input: { command: 'uptime' },
        },
      ],
    },
    {
      text: 'The system has been running for 5 days.',
    },
  ],
})
```

### Mock Tool Execution

Las herramientas MCP se ejecutan realmente durante los tests. Para mockear el comportamiento de las herramientas, necesitarías:

1. Configurar un MCP server de prueba
2. O usar recordings (ver sección siguiente)

## Recordings (Futuro)

El sistema está preparado para usar recordings de interacciones reales:

```typescript
const server = await createTestServer({
  recording: './recordings/tool-uptime.json',
})
```

Esto permite:
- Grabar interacciones reales con LLM
- Reproducirlas en tests sin hacer llamadas API
- Verificar comportamiento con datos reales

## Estructura de un Test de Tool Execution

```typescript
it('should execute tool and verify persistence', async () => {
  const client = await server.createClient()
  
  try {
    // 1. Autenticar
    await client.authenticate()
    
    // 2. Crear channel
    client.send({ type: 'create_channel', agentId: 'agent:iria' })
    const { channelId } = await client.waitFor('channel_created')
    
    // 3. Suscribirse
    client.send({ type: 'subscribe_channel', channelId })
    
    // 4. Enviar mensaje
    client.send({
      type: 'send_message',
      channelId,
      content: { type: 'text', text: 'Check uptime' },
    })
    
    // 5. Verificar eventos
    await client.waitFor('message_sent')
    const toolStart = await client.waitFor((msg) =>
      msg.type === 'message_chunk' && msg.chunkType === 'tool_call_start'
    )
    const toolComplete = await client.waitFor((msg) =>
      msg.type === 'message_chunk' && msg.chunkType === 'tool_call_complete'
    )
    
    // 6. Verificar persistencia
    client.send({ type: 'get_messages', channelId, limit: 50 })
    const history = await client.waitFor('messages_history')
    
    const toolExecution = history.messages.find(m =>
      m.content.type === 'tool_execution'
    )
    
    expect(toolExecution.content.status).toMatch(/^(completed|failed)$/)
    expect(toolExecution.content.toolCallId).toBeTruthy()
    
  } finally {
    client.close()
  }
})
```

## Debugging

### Ver mensajes en cola

```typescript
const queuedMessages = client.getQueuedMessages()
console.log('Messages in queue:', queuedMessages)
```

### Logs del servidor

El TestServer imprime logs en consola. Para ver más detalles, puedes agregar logs en:
- `ConversationManager`
- `MessageProcessor`
- `AnthropicLLMAdapter`

### Inspeccionar base de datos

Los tests crean una BD única por ejecución. Para inspeccionarla:

```bash
# Conectar a MongoDB
mongosh mongodb://localhost:27017

# Listar bases de datos de test
show dbs

# Usar una BD de test
use teros_test_1234567890_abc123

# Ver mensajes
db.messages.find().pretty()

# Ver canales
db.channels.find().pretty()
```

## Features relacionadas

Los tests verifican el comportamiento definido en:
- `docs/features/11-tool-execution.feature` - Especificación de tool execution
- `docs/features/12-content-types.feature` - Content types soportados
- `packages/shared/src/protocol.ts` - Protocolo WebSocket

## Troubleshooting

### "Tool call chunks not received"
- Verificar que el mock LLM incluye `toolCalls` en la respuesta
- Verificar que `AnthropicLLMAdapter` está llamando el callback `onToolCall`

### "tool_execution not persisted"
- Verificar que `MessageProcessor.handleToolCall` se ejecuta
- Verificar que `result.parts` incluye tool parts en `finish()`
- Verificar que `ConversationManager` extrae tool calls correctamente

### "Tests timeout"
- Aumentar timeout en `waitFor()`: `await client.waitFor(..., 15000)`
- Verificar que MongoDB está en ejecución
- Verificar que el LLM mock está configurado correctamente

## Referencias

- Feature 11: [docs/features/11-tool-execution.feature](../../../docs/features/11-tool-execution.feature)
- Protocol: [packages/shared/src/protocol.ts](../../shared/src/protocol.ts)
- TestServer: [TestServer.ts](./TestServer.ts)
