import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const APP_ORIGIN = "https://shinkaevo.github.io";
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": APP_ORIGIN,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}
async function paypalRequest(base: string, token: string, path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || ("PayPal HTTP " + res.status));
  return data;
}
async function getToken(base: string, clientId: string, clientSecret: string) {
  const res = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("PayPal no pudo autorizar la aplicación.");
  return String(data.access_token);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Método no permitido." }, 405);
  if (req.headers.get("Origin") !== APP_ORIGIN) return response({ error: "Origen no permitido." }, 403);

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return response({ error: "Inicia sesión para continuar." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  const environment = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();
  if (!supabaseUrl || !anonKey || !serviceKey) return response({ error: "Faltan claves del servidor Supabase." }, 503);
  if (!clientId || !clientSecret) return response({ error: "PayPal no está configurado en Supabase." }, 503);
  if (environment !== "sandbox" && environment !== "live") return response({ error: "PAYPAL_ENVIRONMENT debe ser sandbox o live." }, 503);

  const body = await req.json();
  const companyId = String(body?.company_id || "");
  const productType = String(body?.product_type || "");
  const planCode = String(body?.plan_code || "");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) return response({ error: "La empresa indicada no es válida." }, 400);
  if (productType !== "core" && productType !== "ai") return response({ error: "El producto no es válido." }, 400);
  if (!/^[a-z0-9_-]{2,30}$/i.test(planCode)) return response({ error: "El plan no es válido." }, 400);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userResult = await userClient.auth.getUser();
  const user = userResult.data.user;
  if (userResult.error || !user) return response({ error: "Tu sesión no es válida." }, 401);

  const memberResult = await admin.from("company_members")
    .select("role")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (memberResult.error || !memberResult.data || memberResult.data.role !== "owner") {
    return response({ error: "Solo el propietario del espacio puede contratar." }, 403);
  }

  const mfaResult = await userClient.rpc("shinka_company_mfa_access_allowed", { p_company_id: companyId });
  if (mfaResult.error || mfaResult.data !== true) {
    return response({ error: "Completa la verificación de seguridad antes de contratar." }, 403);
  }

  const configResult = await admin.from("billing_provider_config")
    .select("environment")
    .eq("provider", "paypal")
    .maybeSingle();
  if (configResult.error || !configResult.data || configResult.data.environment !== environment) {
    return response({ error: "El catálogo PayPal todavía no está preparado para este entorno." }, 503);
  }

  const table = productType === "core" ? "plan_catalog" : "ai_addon_catalog";
  const planResult = await admin.from(table)
    .select("plan_code,display_name,monthly_price_cents,currency,paypal_plan_id,paypal_environment")
    .eq("plan_code", planCode)
    .eq("is_active", true)
    .maybeSingle();
  const plan = planResult.data;
  if (planResult.error || !plan) return response({ error: "No encontramos ese plan." }, 404);
  if (!plan.paypal_plan_id || plan.paypal_environment !== environment) {
    return response({ error: "Este plan todavía no está preparado en PayPal." }, 409);
  }

  const base = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const token = await getToken(base, clientId, clientSecret);
  let existing: any = null;

  if (productType === "core") {
    const existingResult = await admin.from("subscriptions")
      .select("id,plan_code,provider,status,trial_ends_at,current_period_end,provider_subscription_id,provider_approval_url,paypal_pending_plan_code")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (existingResult.error) throw new Error("No pudimos leer tu suscripción actual.");
    existing = existingResult.data?.[0] || null;

    const hasCurrentAccess = ["active", "trialing"].includes(existing?.status)
      && ((!existing?.current_period_end && existing?.status === "active")
        || (existing?.current_period_end && new Date(existing.current_period_end).getTime() > Date.now())
        || (existing?.status === "trialing" && existing?.trial_ends_at && new Date(existing.trial_ends_at).getTime() > Date.now()));

    if (existing?.provider === "paypal" && existing?.provider_subscription_id
        && ["active", "trialing", "incomplete"].includes(existing.status)) {
      if (existing.paypal_pending_plan_code === planCode) {
        if (existing.provider_approval_url) {
          return response({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true });
        }
        return response({ error: "Tu cambio de plan ya está pendiente de confirmación. No lo repitas." }, 409);
      }
      if (existing.plan_code === planCode) {
        if (existing.provider_approval_url) {
          return response({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true });
        }
        return response({ error: "Este plan ya está vinculado a tu suscripción actual." }, 409);
      }

      const revise = await paypalRequest(base, token,
        "/v1/billing/subscriptions/" + encodeURIComponent(existing.provider_subscription_id) + "/revise",
        "POST",
        { plan_id: plan.paypal_plan_id });
      const approvalUrl = String((revise.links || []).find((item: any) => item.rel === "approve")?.href || "");
      if (!approvalUrl) throw new Error("PayPal no devolvió el enlace para confirmar el cambio.");
      const updateResult = await admin.from("subscriptions").update({
        paypal_pending_plan_code: planCode,
        provider_approval_url: approvalUrl,
        updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      if (updateResult.error) throw new Error("PayPal preparó el cambio, pero SHINKA no pudo guardarlo. No repitas el intento.");
      return response({
        approval_url: approvalUrl,
        subscription_id: existing.provider_subscription_id,
        product_type: "core",
        plan_code: planCode,
        revised: true,
      });
    }

    if (hasCurrentAccess && existing?.provider !== "shinka_free_trial" && existing?.provider !== "paypal") {
      return response({ error: "La suscripción actual utiliza otro proveedor. El adulto administrador debe gestionar el cambio sin crear un segundo cobro." }, 409);
    }
    if (existing?.provider === "paypal" && existing?.provider_subscription_id
        && ["past_due", "paused"].includes(existing.status)) {
      return response({ error: "Hay un pago pendiente en PayPal. Resuelve ese estado antes de contratar otro plan." }, 409);
    }
  } else {
    const existingResult = await admin.from("company_ai_subscriptions")
      .select("addon_plan_code,provider,status,current_period_end,provider_subscription_id,provider_approval_url")
      .eq("company_id", companyId)
      .maybeSingle();
    if (existingResult.error) throw new Error("No pudimos leer tu suscripción de SHINKA IA.");
    existing = existingResult.data;

    const aiActive = ["active", "trialing"].includes(existing?.status)
      && existing?.current_period_end
      && new Date(existing.current_period_end).getTime() > Date.now();
    if (aiActive) {
      return response({ error: "SHINKA IA ya tiene una suscripción activa. CORE, FLOW y NEXUS no modifican sus créditos ni su facturación." }, 409);
    }
    if (existing?.provider === "paypal" && existing?.provider_subscription_id
        && ["incomplete", "past_due", "paused"].includes(existing.status)) {
      if (existing.addon_plan_code === planCode && existing.provider_approval_url) {
        return response({ approval_url: existing.provider_approval_url, subscription_id: existing.provider_subscription_id, reused: true });
      }
      return response({ error: "Ya existe un intento o pago pendiente de SHINKA IA. No se creará otro cobro." }, 409);
    }
  }

  const appUrl = "https://shinkaevo.github.io/shinka/";
  const payload: Record<string, unknown> = {
    plan_id: plan.paypal_plan_id,
    custom_id: "SHINKA|" + productType + "|" + companyId + "|" + planCode,
    application_context: {
      brand_name: "SHINKA",
      locale: "es-DO",
      shipping_preference: "NO_SHIPPING",
      user_action: "SUBSCRIBE_NOW",
      payment_method: {
        payer_selected: "PAYPAL",
        payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
      },
      return_url: appUrl + "?paypal=success&product=" + productType,
      cancel_url: appUrl + "?paypal=cancelled&product=" + productType,
    },
  };

  if (productType === "core" && existing?.status === "trialing" && existing?.trial_ends_at) {
    const trialEnd = new Date(existing.trial_ends_at);
    if (trialEnd.getTime() > Date.now() + 60_000) payload.start_time = trialEnd.toISOString();
  }

  const created = await paypalRequest(base, token, "/v1/billing/subscriptions", "POST", payload);
  const subscriptionId = String(created.id || "");
  const approvalUrl = String((created.links || []).find((item: any) => item.rel === "approve")?.href || "");
  if (!subscriptionId || !approvalUrl) throw new Error("PayPal no devolvió un enlace de aprobación.");

  if (productType === "core") {
    const trialActive = existing?.status === "trialing" && existing?.trial_ends_at
      && new Date(existing.trial_ends_at).getTime() > Date.now();
    const values = {
      company_id: companyId,
      plan_code: existing?.plan_code || planCode,
      provider: "paypal",
      provider_subscription_id: subscriptionId,
      provider_approval_url: approvalUrl,
      paypal_pending_plan_code: planCode,
      status: trialActive ? "trialing" : "incomplete",
      billing_interval: "month",
      currency: plan.currency || "USD",
      unit_amount_cents: Number(plan.monthly_price_cents),
      updated_at: new Date().toISOString(),
    };
    const writeResult = existing?.id
      ? await admin.from("subscriptions").update(values).eq("id", existing.id)
      : await admin.from("subscriptions").insert(values);
    if (writeResult.error) throw new Error("PayPal creó la suscripción, pero SHINKA no pudo guardar el intento. Contacta al soporte antes de volver a pagar.");
  } else {
    const writeResult = await admin.from("company_ai_subscriptions").upsert({
      company_id: companyId,
      addon_plan_code: planCode,
      status: "incomplete",
      provider: "paypal",
      provider_subscription_id: subscriptionId,
      provider_approval_url: approvalUrl,
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "company_id" });
    if (writeResult.error) throw new Error("PayPal creó la suscripción, pero SHINKA no pudo guardar el intento.");
  }

  return response({
    approval_url: approvalUrl,
    subscription_id: subscriptionId,
    product_type: productType,
    plan_code: planCode,
    message: "Abre PayPal para aprobar la suscripción. SHINKA activará el plan cuando PayPal confirme el pago.",
  });
});
