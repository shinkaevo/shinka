# SHINKA Engine — servidor propio opcional

**No necesitas este servidor para comenzar.** La ruta inicial recomendada está en [Cloudflare Workers AI](../../docs/SHINKA-AI-engine.md), que ejecuta `gpt-oss-20b` en infraestructura gestionada y ofrece una cuota gratuita diaria.

Este directorio contiene una alternativa para el futuro: ejecutar los pesos abiertos `openai/gpt-oss-20b` en hardware GPU administrado por nosotros, con vLLM y Caddy.

## Requisitos
- Linux x86-64, Docker Engine y Docker Compose v2.
- GPU NVIDIA compatible con MXFP4 y al menos 16 GB de memoria GPU; 24 GB o más es preferible.
- Controlador NVIDIA y NVIDIA Container Toolkit.
- Dominio propio, DNS dirigido al servidor y puertos TCP 80/443.

No es un despliegue para un Chromebook común ni para Supabase Edge Functions. Los pesos son abiertos, pero el cómputo y el alojamiento pueden generar costos.

## Configuración

1. Copia `.env.example` a `.env`.
2. Configura dominio y secreto privado en el servidor. No compartas el secreto ni lo guardes en Git.
3. Desde la raíz del repositorio, arranca:

```sh
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml up -d
```

4. En Supabase Edge Function Secrets se configura:
   - `SHINKA_AI_BASE_URL=https://TU-DOMINIO/v1`
   - `SHINKA_AI_API_KEY=` el secreto del servidor
   - `SHINKA_AI_MODEL=shinka-gpt-oss-20b`

La versión 4 de `shinka-ai-chat` ya acepta esta configuración. Nunca coloques claves privadas en el frontend o en GitHub.

## Operación

```sh
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml ps
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml logs -f vllm
```

Para apagar:

```sh
docker compose --env-file self-hosted/shinka-engine/.env -f self-hosted/shinka-engine/compose.yaml down
```

Este servidor propio queda como opción futura; para empezar usa la ruta de Cloudflare documentada en `docs/SHINKA-AI-engine.md`.
