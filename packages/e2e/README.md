# @teros/e2e - End-to-End Tests

Paquete de tests end-to-end para Teros. Proporciona un entorno aislado con Docker para ejecutar tests completos del sistema.

## ✅ Tests Incluidos

| Suite | Tests | Estado |
|-------|-------|--------|
| Authentication | 6 | ✅ |
| Channels | 3 | ✅ |
| Messaging | 3 | ✅ |
| **Total** | **12** | **✅** |

## Arquitectura

```
packages/e2e/
├── src/
│   ├── adapters/
│   │   └── MockLLMAdapter.ts    # Mock del LLM para tests
│   ├── fixtures/
│   │   └── test-data.ts         # Datos de prueba (usuarios, agentes)
│   ├── scripts/
│   │   └── seed-test-data.ts    # Script para poblar la BD
│   ├── tests/
│   │   ├── auth.test.ts         # Tests de autenticación
│   │   ├── channels.test.ts     # Tests de canales
│   │   └── messaging.test.ts    # Tests de mensajería
│   └── utils/
│       ├── TestClient.ts        # Cliente WebSocket para tests
│       └── setup.ts             # Helpers de setup/teardown
├── scripts/
│   └── run-e2e.sh               # Script todo-en-uno
├── docker-compose.e2e.yml       # Docker Compose para MongoDB
├── package.json
└── README.md
```

## 🚀 Uso Rápido

### Opción 1: Script Todo-en-Uno (Recomendado)

```bash
cd packages/e2e
yarn test:run
```

Este script:
1. ✅ Inicia MongoDB si no está corriendo
2. ✅ Inicia el backend en modo test
3. ✅ Hace seed de datos de prueba
4. ✅ Ejecuta los tests
5. ✅ Limpia al terminar

### Opción 2: Manual

```bash
# Terminal 1: Levantar MongoDB
cd packages/e2e
yarn docker:up

# Terminal 2: Levantar backend en modo test
cd packages/backend
PORT=3002 MONGODB_URI=mongodb://localhost:27018 MONGODB_DATABASE=teros_e2e SESSION_TOKEN_SECRET=e2e-test-secret bun run dev

# Terminal 3: Ejecutar tests
cd packages/e2e
yarn seed
yarn test
```

## 📋 Scripts Disponibles

| Script | Descripción |
|--------|-------------|
| `yarn test` | Ejecuta los tests (requiere backend corriendo) |
| `yarn test:run` | Ejecuta todo el flujo e2e automáticamente |
| `yarn test:watch` | Ejecuta tests en modo watch |
| `yarn seed` | Siembra datos de prueba en la BD |
| `yarn docker:up` | Levanta MongoDB para tests |
| `yarn docker:down` | Para y limpia MongoDB |

## 🔧 Configuración

Variables de entorno (opcionales):

| Variable | Default | Descripción |
|----------|---------|-------------|
| `E2E_WS_URL` | `ws://localhost:3002/ws` | URL del WebSocket |
| `E2E_HTTP_URL` | `http://localhost:3002` | URL HTTP del backend |
| `E2E_MONGO_URI` | `mongodb://localhost:27018` | URI de MongoDB |
| `E2E_DB_NAME` | `teros_e2e` | Nombre de la base de datos |
| `E2E_TIMEOUT` | `10000` | Timeout por defecto (ms) |
| `E2E_DEBUG` | `false` | Habilitar logs de debug |

## 🧪 Estructura de Tests

### auth.test.ts
- ✅ Conexión WebSocket
- ✅ Login con credenciales válidas
- ✅ Rechazo de credenciales inválidas
- ✅ Rechazo de usuario inexistente
- ✅ Autenticación con token
- ✅ Rechazo de token inválido

### channels.test.ts
- ✅ Crear canal
- ✅ Listar canales
- ✅ Cerrar canal

### messaging.test.ts
- ✅ Enviar mensaje y recibir confirmación
- ✅ Obtener historial de mensajes
- ✅ Recibir indicador de typing

## 🔌 TestClient API

```typescript
import { TestClient, createTestClient } from '@teros/e2e';

// Crear cliente autenticado
const client = await createTestClient('user1');

// O manualmente
const client = new TestClient({ url: 'ws://localhost:3002/ws' });
await client.connect();
await client.authenticate('user@test.local', 'password');

// Enviar y esperar respuesta
const response = await client.sendAndWait(
  { type: 'create_channel', agentId: 'agent_123' },
  'channel_created'
);

// Esperar múltiples tipos posibles
const response = await client.sendAndWait(
  { type: 'some_action' },
  ['success', 'error']
);

// Desconectar
await client.disconnect();
```

## 🐳 CI/CD

```yaml
# .github/workflows/e2e.yml
jobs:
  e2e:
    runs-on: ubuntu-latest
    services:
      mongodb:
        image: mongo:7.0
        ports:
          - 27018:27017
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      
      - name: Install dependencies
        run: bun install
        
      - name: Run E2E tests
        run: |
          cd packages/e2e
          yarn seed
          yarn test
        env:
          E2E_MONGO_URI: mongodb://localhost:27018
```

## 🔍 Troubleshooting

### El backend no arranca
```bash
# Verificar logs
cat /tmp/e2e-backend.log
```

### Tests timeout
```bash
# Aumentar timeout
E2E_TIMEOUT=30000 yarn test

# O habilitar debug
E2E_DEBUG=true yarn test
```

### Limpiar todo
```bash
yarn docker:down
pkill -f "PORT=3002"
```
