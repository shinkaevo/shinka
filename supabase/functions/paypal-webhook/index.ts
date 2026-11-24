import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
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
async function api(base: string, token: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(base + path, { method, headers: { Authorization: "Bearer " + token, Accept: "application/json",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || ("PayPal HTTP " + res.status));
  return data;
}
async function tokenFor(base: string, id: string, key: string) {
  const res = await fetch(base + "/v1/oauth2/token", { method: "POST",
    headers: { Authorization: "Basic " + btoa(id + ":" + key), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("PayPal API credentials could not be verified.");
  return data.access_token as string;
}
const toIso = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const plusMonth = (v: string) => { const d = new Date(v); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); };

Deno.serve(async req => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  let event: any; try { event = await req.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
  const url = Deno.env.get("SUPABASE_URL");
  const svc = secret("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", ["SUPABASE_SECRET_KEY"]);
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID"), clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  const env = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();
  if (!url || !svc || !clientId || !clientSecret) return reply({ error: "Server configuration missing" }, 503);
  if (env !== "sandbox" && env !== "live") return reply({ error: "Invalid environment" }, 503);
  const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });
  let logId: string | null = null;
  try {
    const { data: cfg, error: ce } = await admin.from("billing_provider_config").select("environment,webhook_id").eq("provider", "paypal").maybeSingle();
    if (ce || !cfg || cfg.environment !== env || !cfg.webhook_id) return reply({ error: "Webhook not configured" }, 503);
    const token = await tokenFor(base, clientId, clientSecret);
    const verified = await api(base, token, "/v1/notifications/verify-webhook-signature", "POST", {
      auth_algo: req.headers.get("paypal-auth-algo"), cert_url: req.headers.get("paypal-cert-url"),
      transmission_id: req.headers.get("paypal-transmission-id"), transmission_sig: req.headers.get("paypal-transmission-sig"),
      transmission_time: req.headers.get("paypal-transmission-time"), webhook_id: cfg.webhook_id, webhook_event: event,
    });
    if (verified.verification_status !== "SUCCESS") return reply({ error: "Signature verification failed" }, 400);

    const eventId = String(event?.id || ""), eventType = String(event?.event_type || ""), resource = event?.resource || {};
    if (!eventId || !eventType) return reply({ error: "Missing event id/type" }, 400);
    const { data: inserted, error: insertError } = await admin.from("billing_events").insert({
      provider: "paypal", provider_event_id: eventId, event_type: eventType,
      processing_status: "received", event_payload: event,
    }).select("id").single();
    if (insertError) {
      if (insertError.code !== "23505") throw new Error("Could not log webhook event.");
      const { data: prior, error: priorError } = await admin.from("billing_events")
        .select("id,processing_status").eq("provider", "paypal").eq("provider_event_id", eventId).maybeSingle();
      if (priorError || !prior) throw new Error("Could not recover duplicate webhook event.");
      if (prior.processing_status === "processed") return reply({ received: true, duplicate: true });
      logId = prior.id;
      await admin.from("billing_events").update({ processing_status: "received", error_message: null }).eq("id", logId);
    } else logId = inserted.id;

    const subId = eventType.startsWith("BILLING.SUBSCRIPTION.")
      ? String(resource.id || "")
      : String(resource.billing_agreement_id || resource.subscription_id || "");
    let companyId: string | null = null, coreId: string | null = null;

    if (subId) {
      const { data: core, error: coreErr } = await admin.from("subscriptions")
        .select("id,company_id,status,trial_starts_at,trial_ends_at,current_period_start,current_period_end")
        .eq("provider", "paypal").eq("provider_subscription_id", subId)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      const { data: ai, error: aiErr } = await admin.from("company_ai_subscriptions")
        .select("company_id,status,current_period_start,current_period_end")
        .eq("provider", "paypal").eq("provider_subscription_id", subId).maybeSingle();
      if (coreErr || aiErr) throw new Error("Could not locate the SHINKA subscription.");
      companyId = core?.company_id || ai?.company_id || null;
      coreId = core?.id || null;

      const needsDetails = ["BILLING.SUBSCRIPTION.ACTIVATED","BILLING.SUBSCRIPTION.UPDATED","PAYMENT.SALE.COMPLETED"].includes(eventType);
      const details = needsDetails ? await api(base, token, "/v1/billing/subscriptions/" + encodeURIComponent(subId)) : null;

      if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED" || eventType === "BILLING.SUBSCRIPTION.UPDATED") {
        if (!details) throw new Error("PayPal subscription details are missing.");
        const start = toIso(details.start_time) || new Date().toISOString();
        const isScheduled = new Date(start).getTime() > Date.now() + 60_000;
        const periodStart = isScheduled ? start : (toIso(details.billing_info?.last_payment?.time) || start);
        const periodEnd = toIso(details.billing_info?.next_billing_time) || plusMonth(periodStart);
        if (core) {
          const values: Record<string,unknown> = {
            status: isScheduled ? "trialing" : "active",
            provider_customer_id: details.subscriber?.payer_id || null,
            current_period_start: periodStart, current_period_end: periodEnd,
            cancel_at_period_end: false, canceled_at: null, provider_approval_url: null,
            updated_at: new Date().toISOString(),
          };
          if (isScheduled) {
            values.trial_starts_at = core.trial_starts_at || new Date().toISOString();
            values.trial_ends_at = start;
          } else { values.trial_starts_at = null; values.trial_ends_at = null; }
          const { error } = await admin.from("subscriptions").update(values).eq("id", core.id);
          if (error) throw new Error("Could not activate SHINKA subscription.");
        } else if (ai) {
          const { error } = await admin.from("company_ai_subscriptions").update({
            status: isScheduled ? "trialing" : "active", provider_customer_id: details.subscriber?.payer_id || null,
            current_period_start: periodStart, current_period_end: periodEnd, cancel_at_period_end: false,
            canceled_at: null, provider_approval_url: null, updated_at: new Date().toISOString(),
          }).eq("company_id", ai.company_id);
          if (error) throw new Error("Could not activate SHINKA IA.");
        }
      } else if (eventType === "PAYMENT.SALE.COMPLETED" && details) {
        const paidAt = toIso(resource.create_time || resource.update_time || details.billing_info?.last_payment?.time) || new Date().toISOString();
        const nextEnd = toIso(details.billing_info?.next_billing_time);
        if (core) {
          const oldStart = toIso(core.current_period_start), oldEnd = toIso(core.current_period_end);
          const isFirst = core.status === "trialing" && oldStart && new Date(paidAt).getTime() >= new Date(oldStart).getTime() - 60_000;
          const isRenewal = oldEnd && new Date(paidAt).getTime() >= new Date(oldEnd).getTime() - 12 * 60 * 60 * 1000;
          if (isFirst || isRenewal) {
            const periodStart = isRenewal ? oldEnd! : paidAt;
            const { error } = await admin.from("subscriptions").update({
              status: "active", current_period_start: periodStart, current_period_end: nextEnd || plusMonth(periodStart),
              trial_starts_at: null, trial_ends_at: null, provider_approval_url: null, updated_at: new Date().toISOString(),
            }).eq("id", core.id);
            if (error) throw new Error("Could not renew SHINKA subscription.");
          }
        } else if (ai) {
          const oldStart = toIso(ai.current_period_start), oldEnd = toIso(ai.current_period_end);
          const isFirst = !oldStart || !oldEnd;
          const isRenewal = oldEnd && new Date(paidAt).getTime() >= new Date(oldEnd).getTime() - 12 * 60 * 60 * 1000;
          if (isFirst || isRenewal) {
            const periodStart = isRenewal ? oldEnd! : paidAt;
            const { error } = await admin.from("company_ai_subscriptions").update({
              status: "active", current_period_start: periodStart, current_period_end: nextEnd || plusMonth(periodStart),
              provider_approval_url: null, updated_at: new Date().toISOString(),
            }).eq("company_id", ai.company_id);
            if (error) throw new Error("Could not renew SHINKA IA.");
          }
        }
      } else if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
        if (core) {
          const paidThrough = core.current_period_end && new Date(core.current_period_end).getTime() > Date.now();
          const { error } = await admin.from("subscriptions").update({
            status: paidThrough ? "active" : "canceled", cancel_at_period_end: !!paidThrough,
            canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq("id", core.id);
          if (error) throw new Error("Could not save SHINKA cancellation.");
        } else if (ai) {
          const paidThrough = ai.current_period_end && new Date(ai.current_period_end).getTime() > Date.now();
          const { error } = await admin.from("company_ai_subscriptions").update({
            status: paidThrough ? "active" : "canceled", cancel_at_period_end: !!paidThrough,
            canceled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq("company_id", ai.company_id);
          if (error) throw new Error("Could not save SHINKA IA cancellation.");
        }
      } else if (eventType === "BILLING.SUBSCRIPTION.SUSPENDED" || eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
        const status = eventType.endsWith("SUSPENDED") ? "paused" : "past_due";
        if (core) await admin.from("subscriptions").update({ status, updated_at: new Date().toISOString() }).eq("id", core.id);
        else if (ai) await admin.from("company_ai_subscriptions").update({ status, updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
      } else if (eventType === "BILLING.SUBSCRIPTION.EXPIRED") {
        if (core) await admin.from("subscriptions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", core.id);
        else if (ai) await admin.from("company_ai_subscriptions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
      } else if (eventType === "PAYMENT.SALE.REFUNDED" || eventType === "PAYMENT.SALE.REVERSED") {
        if (core) await admin.from("subscriptions").update({ status: "past_due", updated_at: new Date().toISOString() }).eq("id", core.id);
        else if (ai) await admin.from("company_ai_subscriptions").update({ status: "past_due", updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
      }
    }

    if (logId) {
      await admin.from("billing_events").update({ company_id: companyId, subscription_id: coreId,
        processing_status: "processed", processed_at: new Date().toISOString() }).eq("id", logId);
    }
    return reply({ received: true, processed: true });
  } catch (e) {
    if (logId) await admin.from("billing_events").update({
      processing_status: "failed", error_message: e instanceof Error ? e.message.slice(0, 500) : "unknown"
    }).eq("id", logId);
    console.error("paypal-webhook:", e instanceof Error ? e.message : "unknown");
    return reply({ error: "Webhook processing failed" }, 500);
  }
});
