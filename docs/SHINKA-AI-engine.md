# SHINKA Engine — despliegue de un modelo propio

SHINKA separa su producto (memoria, contexto empresarial, controles de acceso, conversaciones y créditos) del motor que genera texto.

## Configuración del motor

La función `shinka-ai-chat` acepta cualquier servidor compatible con la API de Chat Completions:

- `SHINKA_AI_BASE_URL`: URL HTTPS base del servidor, normalmente terminada en `/v1`.
- `SHINKA_AI_API_KEY`: clave privada que autentica SHINKA ante ese servidor.
- `SHINKA_AI_MODEL`: identificador exacto del modelo servido.

Por compatibilidad, si `SHINKA_AI_BASE_URL` no está definido se usa el endpoint de OpenAI y, si falta `SHINKA_AI_API_KEY`, se acepta temporalmente `OPENAI_API_KEY` como alternativa. Ninguna clave debe colocarse en el frontend, en GitHub ni en los mensajes de chat.

## Modelo abierto objetivo

El objetivo de la primera implementación autoalojada es `openai/gpt-oss-20b`. Sus pesos tienen licencia Apache 2.0, pero ejecutarlo no es gratis: el hardware, el alojamiento, el almacenamiento y la operación pueden tener costo. La guía oficial de despliegue con vLLM estima alrededor de 16 GB de memoria de GPU para el modelo 20B.

## Servidor de inferencia

vLLM ofrece un servidor HTTP compatible con `/v1/chat/completions`, que es la interfaz que consume SHINKA. El servidor debe estar desplegado con HTTPS y detrás de un proxy o una capa de autenticación robusta. No se debe exponer directamente a internet una instancia sin protección: la autenticación por API key de vLLM no cubre todos sus endpoints.

## Lo que ya aporta SHINKA

El modelo no administra directamente el negocio. SHINKA Core conserva la autenticación, la verificación MFA, los permisos por empresa, el contexto agregado, el historial, el registro de uso y la reserva/finalización de créditos. El motor recibe solamente los mensajes y el contexto autorizado.

## Estado

Este cambio prepara el adaptador compatible. No activa por sí solo un modelo autoalojado: hace falta desplegar el servidor GPU y configurar los tres secretos anteriores en Supabase Edge Functions. Hasta entonces, el endpoint predeterminado sigue siendo compatible con la configuración existente de OpenAI.
