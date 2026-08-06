# Acceptance Tests

Tests de aceptación que validan el comportamiento del API contra un servidor real levantado, con red real.

A diferencia de los tests de integración, estos tests **no usan TestServer mockeado** — arrancan el backend real (o un entorno de staging) y ejercen el protocolo WebSocket completo.

## Cuándo añadir tests aquí

- Flujos críticos de negocio que deben pasar contra el servidor real
- Validación de contratos de API antes de un deploy
- Tests que requieren dependencias reales (MongoDB, etc.)

## Ejecutar

```bash
bun test packages/backend/tests/acceptance/
```

## Estado

🚧 Por implementar.
