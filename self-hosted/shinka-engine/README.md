# SHINKA Engine (gpt-oss-20b)

Este directorio contiene el servidor de inferencia autoalojado de SHINKA. Usa vLLM para ejecutar los pesos abiertos `openai/gpt-oss-20b`, y Caddy como puerta HTTPS. Solo se publica la ruta `POST /v1/chat/completions`; el puerto de vLLM no se publica directamente.

## Requisitos del servidor

- Linux x86-64 con Docker Engine y Docker Compose v2.
- GPU NVIDIA compatible con el formato MXFP4 y al menos 16 GB de memoria de GPU; 24 GB o más es preferible para mayor margen de contexto y concurrencia.
- Controlador NVIDIA y NVIDIA Container Toolkit instalados.
- Un dominio propio cuyo registro DNS A/AAAA apunte al servidor.
- Puertos TCP 80 y 443 accesibles desde internet para que Caddy pueda emitir y renovar TLS.
- Espacio de disco suficiente para la descarga y caché de los pesos del modelo.

**No es un despliegue para un Chromebook común ni para Supabase Edge Functions.** El modelo se ejecuta en el servidor GPU. Los pesos son abiertos y descargables, pero el cómputo, la electricidad, el almacenamiento y el alojamiento pueden generar costos.

## Preparación

1. Copia `.env.example` a `.env` en este directorio.
2. Pide al administrador del servidor que configure el dominio y una clave aleatoria privada. No compartas la clave en chats ni la guardes en Git.
3. Comprueba que el DNS del dominio ya apunta al servidor y que los puertos 80/443 llegan a él.
4. Desde la raíz del repositorio, inicia el stack:

```sh
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml up -d
```

La primera ejecución descarga la imagen de vLLM y los pesos del modelo. Puede tardar bastante según la conexión y el servidor. Revisa el estado:

```sh
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml ps
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml logs -f vllm
```

Caddy obtendrá automáticamente un certificado TLS cuando el DNS y los puertos sean correctos. El gateway rechaza todas las rutas salvo `POST /v1/chat/completions`. vLLM valida el encabezado Bearer con la clave configurada.

## Conectar SHINKA

En los secretos de Supabase Edge Functions del proyecto, configura:

- `SHINKA_AI_BASE_URL=https://TU-DOMINIO/v1`
- `SHINKA_AI_API_KEY=` el mismo secreto del archivo local `.env`
- `SHINKA_AI_MODEL=shinka-gpt-oss-20b`

No agregues estos valores al frontend ni a GitHub. **El adaptador de `shinka-ai-chat` ya está desplegado en Supabase como versión 4**; no hace falta volver a desplegarlo para conectar el servidor. Cuando se agreguen estos secretos, la función empezará a llamar al motor configurado. Mientras `SHINKA_AI_BASE_URL` no esté definido, se mantiene el modo compatible con OpenAI y seguirá dependiendo de la disponibilidad de esa API. La función conserva autenticación, MFA, aislamiento por empresa, historial y créditos; el servidor GPU solo recibe el contexto que SHINKA autoriza.

## Prueba del endpoint

Desde una máquina administradora con la clave cargada como variable de entorno:

```sh
curl --fail-with-body https://TU-DOMINIO/v1/chat/completions \
  -H "Authorization: Bearer $SHINKA_AI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "shinka-gpt-oss-20b",
    "messages": [{"role": "user", "content": "Responde exactamente: SHINKA Engine conectado."}],
    "max_tokens": 80,
    "stream": false
  }'
```

La respuesta debe incluir `choices[0].message.content` y un objeto `usage`. No expongas el endpoint de vLLM directamente: la documentación oficial advierte que su API key no protege todos los endpoints; por eso este gateway limita las rutas publicadas.

## Operación

- Ver logs: comando `logs -f vllm` mostrado arriba.
- Actualizar: revisar una versión de vLLM compatible antes de cambiar el tag fijado en `compose.yaml`.
- Apagar: `docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml down`.
- Para conservar los pesos descargados, no borres el volumen `model-cache`.

Este primer servidor es texto/conversación. No tiene todavía herramientas de negocio que ejecuten cambios ni reentrenamiento propio. Esas funciones se añadirán en SHINKA Core con permisos y confirmaciones independientes.
