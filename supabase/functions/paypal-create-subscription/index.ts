import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGIN = "https://shinkaevo.github.io";
function reply(data: unknown, status = 200, origin = ORIGIN) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store", "Vary": "Origin" } });
}
function secret(name: string, jsonName?: string, legacy: string[] = []): string | null {
  const direct = Deno.env.get(name); if (direct) return direct;
  const raw = jsonName ? Deno.env.get(jsonName) : null;
  if (raw) { try { const v = JSON.parse(raw); if (typeof v === "string") return v;
    if (v && typeof v === "object") { const d = (v as any).default; if (typeof d === "string") return d;
      const first = Object.values(v).find(x => typeof x === "string"); if (typeof first === "string") return first; }
  } catch { return raw; } }
  for (const n of legacy) { const v = Deno.env.get(n); if (v) return v; }
  return null;
}
async function tokenFor(base: string, id: string, key: string) {
  const r = await fetch(base + "/v1/oauth2/token", { method: "POST",
    headers: { Authorization: "Basic " + btoa(id + ":" + key), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("PayPal no pudo autorizar la aplicación.");
  return d.access_token as string;
}

Deno.serve(async req => {
  const origin = req.headers.get("Origin") || ORIGIN;
  if (req.method === "OPTIONS") return reply({ ok: true }, 200, origin);
  if (req.method !== "POST") return reply({ error: "Método no permitido." }, 405, origin);
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return reply({ error: "Inicia sesión para continuar." }, 401, origin);
    const url = Deno.env.get("SUPABASE_URL");
    const pub = secret("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_ANON_KEY"]);
    const svc = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", ["SUPABASE_SECRET_KEY"]);
    const clientId = Deno.env.get("PAYPAL_CLIENT_ID"), clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
    const env = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();
    if (!url || !pub || !svc) return reply({ error: "La conexión segura con Supabase no está configurada." }, 503, origin);
    if (!clientId || !clientSecret) return reply({ error: "PayPal no está configurado en el servidor." }, 503, origin);
    if (env !== "sandbox" && env !== "live") return reply({ error: "Entorno PayPal no válido." }, 503, origin);
    let body: any; try { body = await req.json(); } catch { return reply({ error: "JSON inválido." }, 400, origin); }
    const companyId = String(body?.company_id || ""), kind = String(body?.product_type || ""), code = String(body?.plan_code || "");
    if (!/^[0-9a-f-]{36}$/i.test(companyId) || !["core","ai"].includes(kind) || !/^[a-z0-9_-]{2,30}$/i.test(code))
      return reply({ error: "Empresa, producto o plan no válido." }, 400, origin);

    const userClient = createClient(url, pub, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ud, error: ue } = await userClient.auth.getUser();
    if (ue || !ud.user) return reply({ error: "Tu sesión no es válida." }, 401, origin);
    const { data: member } = await admin.from("company_members").select("role").eq("company_id", companyId).eq("user_id", ud.user.id).maybeSingle();
    if (!member || member.role !== "owner") return reply({ error: "Solo el propietario de la empresa puede contratar." }, 403, origin);
    const { data: mfa, error: mfaError } = await userClient.rpc("shinka_company_mfa_access_allowed", { p_company_id: companyId });
    if (mfaError || mfa !== true) return reply({ error: "Completa la verificación de seguridad antes de contratar." }, 403, origin);

    const { data: config } = await admin.from("billing_provider_config").select("environment").eq("provider","paypal").maybeSingle();
    if (!config || config.environment !== env) return reply({ error: "El catálogo PayPal aún no está preparado para este entorno." }, 503, origin);
    const table = kind === "core" ? "plan_catalog" : "ai_addon_catalog";
    const { data: plan, error: planError } = await admin.from(table)
      .select("plan_code,display_name,monthly_price_cents,currency,paypal_plan_id,paypal_environment")
      .eq("plan_code", code).eq("is_active", true).maybeSingle();
    if (planError || !plan) return reply({ error: "No encontramos ese plan." }, 404, origin);
    if (!plan.paypal_plan_id || plan.paypal_environment !== env) return reply({ error: "El plan todavía no está configurado en PayPal." }, 409, origin);

    let existing: any = null;
    if (kind === "core") {
      const { data } = await admin.from("subscriptions").select("id,plan_code,provider,status,trial_starts_at,trial_ends_at,current_period_start,current_period_end,provider_subscription_id,provider_approval_url,paypal_pending_plan_code")
        .eq("company_id", companyId).order("created_at", { ascending: false }).limit(1);
      existing = data?.[0] || null;
      // A paid PayPal plan can be upgraded/downgraded in-place. The AI add-on
      // remains an independent subscription and is never changed by this flow.
    } else {
      const { data } = await admin.from("company_ai_subscriptions").select("addon_plan_code,provider,status,current_period_end,provider_subscription_id,provider_approval_url")
        .eq("company_id", companyId).maybeSingle();
      existing = data;
      if (existing?.status === "active" && existing.current_period_end && new Date(existing.current_period_end).getTime() > Date.now())
        return reply({ error: "SHINKA IA ya está activo. Cambiar CORE, FLOW o NEXUS no modifica sus créditos ni su suscripción; el complemento se administra por separado." }, 409, origin);
      if (existing?.provider === "paypal" && existing?.provider_subscription_id) {
        if (existing.provider_approval_url) {
          return reply({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true }, 200, origin);
        }
        return reply({ error: "Ya existe una suscripción PayPal pendiente para SHINKA IA. No se creará otro cobro." }, 409, origin);
      }
    }

    const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const token = await tokenFor(base, clientId, clientSecret);

    if (kind === "core" && existing?.provider === "paypal" && existing?.provider_subscription_id
        && ["active", "trialing", "incomplete"].includes(existing.status)) {
      if (existing.plan_code === planCode && !existing.paypal_pending_plan_code) {
        if (existing.provider_approval_url) {
          return reply({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true }, 200, origin);
        }
        return reply({ error: "Este plan ya está vinculado a tu suscripción actual." }, 409, origin);
      }
      if (existing.paypal_pending_plan_code === planCode && existing.provider_approval_url) {
        return reply({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true }, 200, origin);
      }
      const reviseResponse = await fetch(base + "/v1/billing/subscriptions/" + encodeURIComponent(existing.provider_subscription_id) + "/revise", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "PayPal-Request-Id": crypto.randomUUID() },
        body: JSON.stringify({ plan_id: plan.paypal_plan_id }),
        signal: AbortSignal.timeout(25000),
      });
      const reviseData = await reviseResponse.json().catch(() => ({}));
      if (!reviseResponse.ok) throw new Error(reviseData.message || "PayPal no pudo preparar el cambio de plan.");
      const approvalUrl = String((reviseData.links || []).find((x: any) => x?.rel === "approve")?.href || "");
      if (!approvalUrl) throw new Error("PayPal no devolvió el enlace para confirmar el cambio de plan.");
      const { error: reviseSaveError } = await admin.from("subscriptions").update({
        paypal_pending_plan_code: planCode,
        provider_approval_url: approvalUrl,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      if (reviseSaveError) throw new Error("PayPal preparó el cambio, pero SHINKA no pudo guardar la confirmación. No repitas el intento; contacta al soporte.");
      return reply({ approval_url: approvalUrl, subscription_id: existing.provider_subscription_id, product_type: "core", plan_code: planCode, revised: true }, 200, origin);
    }

    if (kind === "core" && existing?.status === "active"
        && (!existing.current_period_end || new Date(existing.current_period_end).getTime() > Date.now())
        && existing.provider !== "paypal") {
      return reply({ error: "Esta suscripción fue creada con otro método. No crearemos una segunda para evitar dobles cobros; el adulto administrador debe gestionar el cambio desde el proveedor actual." }, 409, origin);
    }
    if (kind === "core" && existing?.provider === "paypal" && existing?.provider_subscription_id
        && ["past_due", "paused"].includes(existing.status)) {
      return reply({ error: "La suscripción actual tiene un pago pendiente. Resuelve ese estado en PayPal antes de crear otro plan." }, 409, origin);
    }

    const appUrl = "https://shinkaevo.github.io/shinka/";
    const payload: Record<string, unknown> = {
      plan_id: plan.paypal_plan_id,
      custom_id: "SHINKA|" + kind + "|" + companyId + "|" + code,
      application_context: {
        brand_name: "SHINKA", locale: "es-DO", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
        payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
        return_url: appUrl + "?paypal=success&product=" + kind,
        cancel_url: appUrl + "?paypal=cancelled&product=" + kind,
      },
    };
    if (kind === "core" && existing?.status === "trialing" && existing?.trial_ends_at) {
      const end = new Date(existing.trial_ends_at);
      if (end.getTime() > Date.now() + 60_000) payload.start_time = end.toISOString();
    }

    const response = await fetch(base + "/v1/billing/subscriptions", { method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json", "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(25000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || "PayPal rechazó la creación de la suscripción.");
    const subscriptionId = String(result.id || "");
    const approvalUrl = String((result.links || []).find((x: any) => x?.rel === "approve")?.href || "");
    if (!subscriptionId || !approvalUrl) throw new Error("PayPal no devolvió el enlace de aprobación.");

    if (kind === "core") {
      const trialActive = existing?.status === "trialing" && existing?.trial_ends_at && new Date(existing.trial_ends_at).getTime() > Date.now();
      const values = {
        company_id: companyId, plan_code: existing?.plan_code || code, provider: "paypal", provider_subscription_id: subscriptionId,
        provider_approval_url: approvalUrl, paypal_pending_plan_code: code,
        status: trialActive ? "trialing" : "incomplete", billing_interval: "month",
        currency: plan.currency || "USD", unit_amount_cents: Number(plan.monthly_price_cents), updated_at: new Date().toISOString(),
      };
      const write = existing?.id
        ? await admin.from("subscriptions").update(values).eq("id", existing.id)
        : await admin.from("subscriptions").insert(values);
      if (write.error) throw new Error("PayPal creó la suscripción, pero SHINKA no pudo guardar el intento. No vuelvas a pagar; contacta al soporte.");
    } else {
      const { error } = await admin.from("company_ai_subscriptions").upsert({
        company_id: companyId, addon_plan_code: code, status: "incomplete", provider: "paypal",
        provider_subscription_id: subscriptionId, provider_approval_url: approvalUrl,
        current_period_start: null, current_period_end: null, cancel_at_period_end: false, canceled_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id" });
      if (error) throw new Error("PayPal creó la suscripción, pero SHINKA no pudo guardar el intento.");
    }
    return reply({ approval_url: approvalUrl, subscription_id: subscriptionId, product_type: kind, plan_code: code }, 200, origin);
  } catch (e) {
    console.error("paypal-create-subscription:", e instanceof Error ? e.message : "unknown");
    return reply({ error: e instanceof Error ? e.message : "No pudimos iniciar PayPal." }, 500, origin);
  }
});
