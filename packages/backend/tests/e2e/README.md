# E2E Tests

Tests end-to-end con interfaz de usuario usando Playwright.

Estos tests ejercen la aplicación completa desde el navegador, incluyendo el frontend React Native/Expo y el backend WebSocket.

## Cuándo añadir tests aquí

- Flujos críticos que involucran la UI (login, envío de mensajes, creación de agentes)
- Regresiones visuales o de interacción
- Smoke tests de producción

## Ejecutar

```bash
bun test packages/backend/tests/e2e/
```

## Estado

🚧 Por implementar — se usará Playwright cuando se añadan los primeros tests.
