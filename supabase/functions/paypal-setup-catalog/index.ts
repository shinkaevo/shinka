import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGIN = "https://shinkaevo.github.io";
const reply = (data: unknown, status = 200, origin = ORIGIN) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store", "Vary": "Origin" },
});
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
async function api(base: string, token: string, path: string, method = "GET", body?: unknown, requestId?: string) {
  const headers: Record<string,string> = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.message || ("PayPal HTTP " + res.status)) + (data.details?.[0]?.description ? ": " + data.details[0].description : ""));
  return data;
}
async function tokenFor(base: string, id: string, key: string) {
  const res = await fetch(base + "/v1/oauth2/token", { method: "POST",
    headers: { Authorization: "Basic " + btoa(id + ":" + key), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("PayPal no aceptó las credenciales de este entorno.");
  return data.access_token as string;
}
const amount = (cents: number) => (cents / 100).toFixed(2);

Deno.serve(async req => {
  const origin = req.headers.get("Origin") || ORIGIN;
  if (req.method === "OPTIONS") return reply({ ok: true }, 200, origin);
  if (req.method !== "POST") return reply({ error: "Método no permitido." }, 405, origin);
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return reply({ error: "Inicia sesión como desarrollador." }, 401, origin);
    const url = Deno.env.get("SUPABASE_URL");
    const pub = secret("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_ANON_KEY"]);
    const svc = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", ["SUPABASE_SECRET_KEY"]);
    const clientId = Deno.env.get("PAYPAL_CLIENT_ID"), clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
    const env = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();
    if (!url || !pub || !svc) return reply({ error: "Faltan claves de Supabase en el servidor." }, 503, origin);
    if (!clientId || !clientSecret) return reply({ error: "Faltan PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET en los secretos." }, 503, origin);
    if (env !== "sandbox" && env !== "live") return reply({ error: "PAYPAL_ENVIRONMENT debe ser sandbox o live." }, 503, origin);
    const userClient = createClient(url, pub, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ud, error: ue } = await userClient.auth.getUser();
    if (ue || !ud.user) return reply({ error: "La sesión no es válida." }, 401, origin);
    const { data: dev } = await admin.from("platform_developers").select("user_id").eq("user_id", ud.user.id).eq("is_active", true).maybeSingle();
    if (!dev) return reply({ error: "Solo el desarrollador autorizado puede preparar PayPal." }, 403, origin);

    const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const token = await tokenFor(base, clientId, clientSecret);
    const { data: cfg } = await admin.from("billing_provider_config").select("environment,webhook_id,product_ids").eq("provider", "paypal").maybeSingle();
    const products: Record<string,string> = {};
    const names: Record<string,string> = { core: "SHINKA · Plataforma de gestión", ai: "SHINKA IA · Complemento" };
    for (const kind of ["core", "ai"]) {
      let id = cfg?.environment === env ? String(cfg.product_ids?.[kind] || "") : "";
      if (!id) {
        const created = await api(base, token, "/v1/catalogs/products", "POST", {
          name: names[kind],
          description: kind === "core" ? "Suscripción mensual a la plataforma SHINKA." : "Complemento mensual independiente SHINKA IA.",
          type: "SERVICE", category: "SOFTWARE", home_url: "https://shinkaevo.github.io/shinka/"
        }, "shinka-product-" + kind + "-v1-" + env);
        id = String(created.id || "");
      }
      if (!id) throw new Error("PayPal no devolvió el producto " + kind + ".");
      products[kind] = id;
    }

    const [coreRes, aiRes] = await Promise.all([
      admin.from("plan_catalog").select("plan_code,display_name,description,monthly_price_cents,currency,paypal_plan_id,paypal_environment").eq("is_active", true).order("display_order"),
      admin.from("ai_addon_catalog").select("plan_code,display_name,description,monthly_price_cents,currency,paypal_plan_id,paypal_environment").eq("is_active", true).order("display_order")
    ]);
    if (coreRes.error || aiRes.error) throw new Error("No pudimos leer el catálogo de planes de SHINKA.");
    const createdPlans: Array<Record<string,string>> = [];
    async function ensurePlan(kind: "core" | "ai", p: any) {
      if (p.paypal_plan_id && p.paypal_environment === env) {
        createdPlans.push({ product: kind, code: p.plan_code, paypal_plan_id: p.paypal_plan_id }); return;
      }
      const cents = Number(p.monthly_price_cents);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error("Define un precio mensual para " + p.display_name + ".");
      const made = await api(base, token, "/v1/billing/plans", "POST", {
        product_id: products[kind], name: p.display_name, description: p.description || p.display_name, status: "ACTIVE",
        billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
          pricing_scheme: { fixed_price: { value: amount(cents), currency_code: p.currency || "USD" } } }],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 2 }
      }, "shinka-plan-" + kind + "-" + p.plan_code + "-v1-" + env);
      const id = String(made.id || "");
      if (!id) throw new Error("PayPal no devolvió el plan " + p.display_name + ".");
      const table = kind === "core" ? "plan_catalog" : "ai_addon_catalog";
      const { error } = await admin.from(table).update({ paypal_plan_id: id, paypal_environment: env, updated_at: new Date().toISOString() }).eq("plan_code", p.plan_code);
      if (error) throw new Error("No pudimos guardar el plan PayPal de " + p.display_name + ".");
      createdPlans.push({ product: kind, code: p.plan_code, paypal_plan_id: id });
    }
    for (const p of coreRes.data || []) await ensurePlan("core", p);
    for (const p of aiRes.data || []) await ensurePlan("ai", p);

    const webhookUrl = url.replace(/\/+$/, "") + "/functions/v1/paypal-webhook";
    let webhookId = cfg?.environment === env ? String(cfg.webhook_id || "") : "";
    if (!webhookId) {
      const hook = await api(base, token, "/v1/notifications/webhooks", "POST", {
        url: webhookUrl,
        event_types: ["BILLING.SUBSCRIPTION.CREATED","BILLING.SUBSCRIPTION.ACTIVATED","BILLING.SUBSCRIPTION.UPDATED",
          "BILLING.SUBSCRIPTION.EXPIRED","BILLING.SUBSCRIPTION.CANCELLED","BILLING.SUBSCRIPTION.SUSPENDED",
          "BILLING.SUBSCRIPTION.PAYMENT.FAILED","PAYMENT.SALE.COMPLETED","PAYMENT.SALE.REFUNDED","PAYMENT.SALE.REVERSED"]
          .map(name => ({ name }))
      }, "shinka-webhook-v1-" + env);
      webhookId = String(hook.id || "");
    }
    if (!webhookId) throw new Error("PayPal no devolvió el ID del webhook.");
    const { error: saveError } = await admin.from("billing_provider_config").upsert({
      provider: "paypal", environment: env, webhook_id: webhookId, product_ids: products, updated_at: new Date().toISOString()
    }, { onConflict: "provider" });
    if (saveError) throw new Error("No pudimos guardar el webhook de PayPal.");
    return reply({ ok: true, environment: env, products, webhook_url: webhookUrl, plans: createdPlans,
      message: "Catálogo y webhook creados en " + env + "." }, 200, origin);
  } catch (e) {
    console.error("paypal-setup-catalog:", e instanceof Error ? e.message : "unknown");
    return reply({ error: e instanceof Error ? e.message : "No pudimos configurar PayPal." }, 500, origin);
  }
});
