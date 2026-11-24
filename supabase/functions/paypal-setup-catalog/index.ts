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

async function paypalRequest(base: string, accessToken: string, path: string, method = "GET", body?: unknown, requestId?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + accessToken,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || ("PayPal HTTP " + res.status));
  return data;
}

async function accessToken(base: string, clientId: string, clientSecret: string) {
  const res = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("PayPal no aceptó las credenciales configuradas.");
  return data.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return response({ ok: true });
  if (req.method !== "POST") return response({ error: "Método no permitido." }, 405);
  if (req.headers.get("Origin") !== APP_ORIGIN) return response({ error: "Origen no permitido." }, 403);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return response({ error: "Inicia sesión como desarrollador." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  const environment = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();

  if (!supabaseUrl || !anonKey || !serviceKey) return response({ error: "Faltan las claves del servidor Supabase." }, 503);
  if (!clientId || !clientSecret) return response({ error: "Faltan PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET en Supabase." }, 503);
  if (environment !== "sandbox" && environment !== "live") return response({ error: "PAYPAL_ENVIRONMENT debe ser sandbox o live." }, 503);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const userResult = await userClient.auth.getUser();
  if (userResult.error || !userResult.data.user) return response({ error: "La sesión no es válida." }, 401);
  const developerResult = await admin.from("platform_developers")
    .select("user_id")
    .eq("user_id", userResult.data.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!developerResult.data) return response({ error: "Solo el desarrollador autorizado puede preparar PayPal." }, 403);

  const base = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const token = await accessToken(base, clientId, clientSecret);
  const configResult = await admin.from("billing_provider_config")
    .select("environment,webhook_id,product_ids")
    .eq("provider", "paypal")
    .maybeSingle();
  if (configResult.error) throw new Error(configResult.error.message);
  const config = configResult.data;

  const names: Record<string, string> = {
    core: "SHINKA · Plataforma de gestión",
    ai: "SHINKA IA · Complemento",
  };
  const productIds: Record<string, string> = {};
  const listResult = await paypalRequest(base, token, "/v1/catalogs/products?page_size=20&page=1");
  const listedProducts = Array.isArray(listResult.products) ? listResult.products : [];

  for (const kind of ["core", "ai"]) {
    let productId = config?.environment === environment ? String(config.product_ids?.[kind] || "") : "";
    if (!productId) {
      const match = listedProducts.find((item: any) => item.name === names[kind]);
      productId = String(match?.id || "");
    }
    if (!productId) {
      const created = await paypalRequest(base, token, "/v1/catalogs/products", "POST", {
        name: names[kind],
        description: kind === "core"
          ? "Suscripción mensual a la plataforma SHINKA."
          : "Complemento mensual independiente SHINKA IA.",
        type: "SERVICE",
        category: "SOFTWARE",
        home_url: "https://shinkaevo.github.io/shinka/",
      }, "shinka-product-" + kind + "-v1-" + environment);
      productId = String(created.id || "");
    }
    if (!productId) throw new Error("PayPal no devolvió el producto " + kind + ".");
    productIds[kind] = productId;
  }

  const coreResult = await admin.from("plan_catalog")
    .select("plan_code,display_name,description,monthly_price_cents,currency,paypal_plan_id,paypal_environment")
    .eq("is_active", true)
    .order("display_order");
  const aiResult = await admin.from("ai_addon_catalog")
    .select("plan_code,display_name,description,monthly_price_cents,currency,paypal_plan_id,paypal_environment")
    .eq("is_active", true)
    .order("display_order");
  if (coreResult.error || aiResult.error) throw new Error("No pudimos leer los planes de SHINKA.");

  const createdPlans: Array<Record<string, string>> = [];
  const ensurePlan = async (kind: string, plan: any) => {
    if (plan.paypal_plan_id && plan.paypal_environment === environment) {
      createdPlans.push({ product: kind, code: plan.plan_code, paypal_plan_id: plan.paypal_plan_id });
      return;
    }
    const cents = Number(plan.monthly_price_cents);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error("Define un precio para " + plan.display_name + ".");
    const created = await paypalRequest(base, token, "/v1/billing/plans", "POST", {
      product_id: productIds[kind],
      name: plan.display_name,
      description: plan.description || plan.display_name,
      status: "ACTIVE",
      billing_cycles: [{
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: {
            value: (cents / 100).toFixed(2),
            currency_code: plan.currency || "USD",
          },
        },
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 2,
      },
    }, "shinka-plan-" + kind + "-" + plan.plan_code + "-v1-" + environment);
    const paypalPlanId = String(created.id || "");
    if (!paypalPlanId) throw new Error("PayPal no devolvió el plan " + plan.display_name + ".");
    const table = kind === "core" ? "plan_catalog" : "ai_addon_catalog";
    const updateResult = await admin.from(table).update({
      paypal_plan_id: paypalPlanId,
      paypal_environment: environment,
      updated_at: new Date().toISOString(),
    }).eq("plan_code", plan.plan_code);
    if (updateResult.error) throw new Error("No pudimos guardar el plan " + plan.display_name + ".");
    createdPlans.push({ product: kind, code: plan.plan_code, paypal_plan_id: paypalPlanId });
  };

  for (const plan of coreResult.data || []) await ensurePlan("core", plan);
  for (const plan of aiResult.data || []) await ensurePlan("ai", plan);

  const webhookUrl = supabaseUrl.replace(/\/+$/, "") + "/functions/v1/paypal-webhook";
  let webhookId = config?.environment === environment ? String(config.webhook_id || "") : "";
  if (!webhookId) {
    const hooksResult = await paypalRequest(base, token, "/v1/notifications/webhooks?page_size=20&page=1");
    const found = Array.isArray(hooksResult.webhooks)
      ? hooksResult.webhooks.find((item: any) => item.url === webhookUrl)
      : null;
    webhookId = String(found?.id || "");
  }
  if (!webhookId) {
    const eventNames = [
      "BILLING.SUBSCRIPTION.CREATED",
      "BILLING.SUBSCRIPTION.ACTIVATED",
      "BILLING.SUBSCRIPTION.UPDATED",
      "BILLING.SUBSCRIPTION.EXPIRED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
      "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
      "PAYMENT.SALE.COMPLETED",
      "PAYMENT.SALE.REFUNDED",
      "PAYMENT.SALE.REVERSED",
    ];
    const eventTypes = eventNames.map((name) => ({ name }));
    const hook = await paypalRequest(base, token, "/v1/notifications/webhooks", "POST", {
      url: webhookUrl,
      event_types: eventTypes,
    }, "shinka-webhook-v1-" + environment);
    webhookId = String(hook.id || "");
  }
  if (!webhookId) throw new Error("PayPal no devolvió el ID del webhook.");

  const saveResult = await admin.from("billing_provider_config").upsert({
    provider: "paypal",
    environment,
    webhook_id: webhookId,
    product_ids: productIds,
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider" });
  if (saveResult.error) throw new Error("No pudimos guardar la configuración de PayPal.");

  return response({
    ok: true,
    environment,
    products: productIds,
    webhook_url: webhookUrl,
    plans: createdPlans,
    message: "Catálogo y webhook creados en " + environment + ".",
  });
});
