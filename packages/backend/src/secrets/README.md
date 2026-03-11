# Secrets Manager

Sistema centralizado para gestionar secretos y credenciales del sistema.

## Estructura de Archivos

```
.secrets/
├── system/
│   ├── anthropic.json       # Credenciales de Anthropic
│   ├── openai.json          # Credenciales de OpenAI
│   ├── database.json        # Credenciales de MongoDB
│   └── auth.json            # Secretos de autenticación
│
└── mcas/
    ├── mca.teros.perplexity/
    │   └── credentials.json
    └── mca.teros.gmail/
        └── credentials.json
```

## API

### Uso Básico

```typescript
import { secretsManager } from './secrets/secrets-manager';

// Cargar todos los secretos al inicio
await secretsManager.load();

// Obtener secretos del sistema
const anthropicKey = secretsManager.getSystem('anthropic').apiKey;
const dbUri = secretsManager.getSystem('database').uri;

// Obtener secretos de una MCA
const perplexityKey = secretsManager.getMCA('mca.teros.perplexity').apiKey;

// Verificar si existen secretos
if (secretsManager.hasSystem('openai')) {
  const openaiKey = secretsManager.getSystem('openai').apiKey;
}

// Recargar secretos (hot-reload)
await secretsManager.reload();
```

### Formato de Archivos

#### `.secrets/system/anthropic.json`
```json
{
  "apiKey": "sk-ant-api03-..."
}
```

#### `.secrets/system/database.json`
```json
{
  "uri": "mongodb://localhost:27017",
  "database": "teros"
}
```

#### `.secrets/system/auth.json`
```json
{
  "sessionTokenSecret": "your-secret-key-here"
}
```

#### `.secrets/mcas/mca.teros.perplexity/credentials.json`
```json
{
  "apiKey": "pplx-..."
}
```

## Validación

El SecretsManager valida:
- ✅ Que los archivos existan
- ✅ Que sean JSON válido
- ✅ Que contengan las claves requeridas
- ✅ Que los valores no estén vacíos

## Errores

Si falta un secreto requerido:
```
Error: Missing required secret file: .secrets/system/anthropic.json
```

Si falta una clave en el archivo:
```
Error: Missing required key 'apiKey' in .secrets/system/anthropic.json
```

## Seguridad

- ❌ NO commitear archivos `.secrets/` a git (incluido en .gitignore)
- ✅ Usar permisos 600 en archivos de secretos
- ✅ Mantener backups cifrados
- ✅ Rotar secretos regularmente
