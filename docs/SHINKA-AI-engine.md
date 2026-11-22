# SHINKA Engine — ejecución en la nube

SHINKA separa el producto del motor que genera texto. **SHINKA Core** conserva autenticación, MFA, permisos por empresa, historial, contexto empresarial y créditos. El motor puede ejecutarse en infraestructura gestionada o en un servidor propio.

## Ruta principal recomendada: Cloudflare Workers AI

Como no hay una GPU propia disponible, la primera implementación operativa debe usar **Cloudflare Workers AI**. Cloudflare aloja los modelos sobre sus GPU; no hay que alquilar, instalar ni mantener hardware propio.

Modelo: `@cf/openai/gpt-oss-20b`.

Cloudflare documenta que este modelo:
- está alojado en Cloudflare;
- admite razonamiento, function calling y una ventana de contexto de 128,000 tokens;
- ofrece endpoints compatibles con OpenAI Chat Completions;
- tiene tarifa publicada de $0.20 por millón de tokens de entrada y $0.30 por millón de salida.

Workers AI incluye 10,000 Neurons por día en el plan Free. La cuota se reinicia diariamente a las 00:00 UTC. Al superar la cuota gratuita, las solicitudes se rechazan en el plan Free; no se debe habilitar facturación de pago sin que el adulto administrador lo revise y autorice. Para `gpt-oss-20b`, la tabla actual publica 18,182 Neurons por millón de tokens de entrada y 27,273 por millón de tokens de salida.

Fuentes oficiales:
- [Modelo gpt-oss-20b en Workers AI](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Precios y cuota gratuita de Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Endpoints compatibles con OpenAI](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Preparar la cuenta, token y Account ID](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)

### Configuración privada en Supabase

El adulto que administre la cuenta de Cloudflare debe:
1. Abrir Workers AI en el panel de Cloudflare y usar el flujo oficial **Use REST API / Create a Workers AI API Token**.
2. Obtener el Account ID y crear el token de Workers AI. Si crea un token manual, Cloudflare documenta los permisos `Workers AI - Read` y `Workers AI - Edit`.
3. Guardar estos secretos en Supabase Edge Function Secrets, nunca en GitHub ni en el frontend:

- `SHINKA_AI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1`
- `SHINKA_AI_API_KEY=TOKEN_PRIVADO_DE_CLOUDFLARE`
- `SHINKA_AI_MODEL=@cf/openai/gpt-oss-20b`

El adaptador de `shinka-ai-chat` ya está desplegado en Supabase como versión 4. Añade automáticamente `/chat/completions` al base URL y envía el encabezado Bearer. No hace falta volver a desplegar la función al configurar esos secretos.

El modelo se ejecutará en la infraestructura de Cloudflare; SHINKA seguirá conservando permisos, MFA, aislamiento entre empresas, historial y créditos internos. La cuota de Cloudflare es independiente de los créditos comerciales de SHINKA.

**No se debe activar el plan de pago ni añadir un método de pago sin autorización del adulto administrador.** La cuota gratuita puede ser suficiente para pruebas iniciales, pero tiene límites diarios y de capacidad.

## Ruta futura: servidor propio

Si más adelante hay acceso autorizado a una máquina GPU compatible, el paquete `self-hosted/shinka-engine/` contiene la configuración alternativa con vLLM y Caddy. Esto no es necesario para empezar con Cloudflare Workers AI.

## Estado

- [x] Separar el motor del producto SHINKA.
- [x] Añadir adaptador configurable compatible con OpenAI Chat Completions.
- [x] Mantener compatibilidad con la API Responses de OpenAI.
- [x] Desplegar el adaptador en Supabase (versión 4; JWT obligatorio).
- [x] Documentar Cloudflare Workers AI como ruta sin servidor GPU propio.
- [ ] El administrador configura los tres secretos privados de Cloudflare en Supabase.
- [ ] Probar una respuesta real de SHINKA usando gpt-oss-20b en Cloudflare.
- [ ] Vigilar consumo y cuota antes de abrirlo a más usuarios.

La disponibilidad del modelo no equivale a una IA entrenada desde cero por SHINKA. SHINKA será dueño de su aplicación, su lógica, la memoria empresarial, sus permisos y su integración; gpt-oss es el modelo de pesos abiertos que genera las respuestas.
