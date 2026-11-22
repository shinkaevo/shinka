# SHINKA Engine — motor abierto autoalojado

SHINKA separa el producto del motor que genera texto. **SHINKA Core** conserva autenticación, MFA, permisos por empresa, historial, contexto empresarial y créditos. **SHINKA Engine** ejecuta el modelo abierto en una máquina que controla el administrador.

## Modelo elegido

Primera versión: `openai/gpt-oss-20b`, con licencia Apache 2.0. OpenAI publica sus pesos para descarga y documenta una necesidad aproximada de 16 GB de memoria para la variante 20B. El requisito real depende del backend, longitud del contexto, concurrencia y hardware; para esta configuración recomendamos más margen, idealmente 24 GB o más.

Referencias:
- [OpenAI: presentación de gpt-oss](https://openai.com/index/introducing-gpt-oss/)
- [OpenAI: guía para ejecutar gpt-oss con Transformers](https://developers.openai.com/cookbook/articles/gpt-oss/run-transformers/)
- [vLLM: modelos compatibles](https://docs.vllm.ai/en/latest/models/supported_models/)

Los pesos abiertos no equivalen a inferencia gratuita: alguien debe aportar GPU, almacenamiento, electricidad, conectividad y mantenimiento. No es realista ejecutar esta configuración dentro de Supabase Edge Functions o en un Chromebook común.

## Servidor listo para desplegar

El paquete reproducible está en `self-hosted/shinka-engine/`:
- `compose.yaml`: vLLM con imagen fijada, modelo gpt-oss-20b, caché persistente, límites iniciales de contexto/concurrencia y comprobación de salud.
- `Caddyfile`: HTTPS automático y exposición exclusiva de `POST /v1/chat/completions`.
- `.env.example`: plantilla local de dominio y secreto; el archivo real `.env` está excluido de Git.
- `README.md`: requisitos, arranque, conexión con Supabase y prueba funcional.

vLLM proporciona una API compatible con OpenAI. Su propia documentación advierte que la opción de API key no protege todas las rutas del servidor, por eso el paquete no publica directamente el puerto 8000 y filtra las rutas con Caddy.

Referencias:
- [vLLM: servidor compatible con OpenAI y limitaciones de API key](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)
- [vLLM: despliegue con Docker](https://docs.vllm.ai/en/latest/deployment/docker/)
- [vLLM: lanzamientos](https://github.com/vllm-project/vllm/releases)

## Configuración de SHINKA Edge Function

El adaptador acepta cualquier servidor HTTPS compatible con Chat Completions mediante estas variables de entorno privadas:

- `SHINKA_AI_BASE_URL=https://TU-DOMINIO/v1`
- `SHINKA_AI_API_KEY=...`
- `SHINKA_AI_MODEL=shinka-gpt-oss-20b`

Para conservar compatibilidad, si no se define `SHINKA_AI_BASE_URL` la función sigue usando el endpoint Responses de OpenAI existente y acepta `OPENAI_API_KEY` como clave heredada. Para un servidor autoalojado, configura los tres valores anteriores en los secretos de Supabase Edge Functions. Nunca los pongas en el frontend, en GitHub o en una conversación.

El adaptador valida HTTPS, rechaza URL con credenciales embebidas, query o fragmento y normaliza las métricas de uso de tokens para el sistema actual de créditos.

## Estado de implementación

- [x] Separar el motor del producto SHINKA.
- [x] Añadir adaptador HTTPS configurable para Chat Completions sin romper el modo Responses anterior.
- [x] Añadir un paquete Docker reproducible con vLLM y gateway HTTPS.
- [x] Revisar y fusionar el PR de implementación (#19).
- [ ] Desplegar el servidor en una máquina GPU compatible bajo administración autorizada.
- [x] Desplegar el adaptador de `shinka-ai-chat` en Supabase (versión 4; JWT obligatorio).
- [ ] Configurar los secretos privados `SHINKA_AI_BASE_URL`, `SHINKA_AI_API_KEY` y `SHINKA_AI_MODEL`.
- [ ] Ejecutar prueba real de ida y vuelta desde SHINKA.

Este paquete deja la ruta de ejecución preparada, pero no crea una máquina GPU ni activa por sí solo un modelo remoto. La cuenta del servidor, cualquier pago y sus credenciales deben ser gestionados por el adulto administrador.
