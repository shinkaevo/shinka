import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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
  if (!res.ok || !data.access_token) throw new Error("PayPal API credentials could not be verified.");
  return String(data.access_token);
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function addMonth(value: string): string {
  const date = new Date(value);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const event: any = await req.json();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  const environment = (Deno.env.get("PAYPAL_ENVIRONMENT") || "sandbox").toLowerCase();
  if (!supabaseUrl || !serviceKey || !clientId || !clientSecret) {
    return response({ error: "Webhook server configuration missing" }, 503);
  }
  if (environment !== "sandbox" && environment !== "live") {
    return response({ error: "Invalid PayPal environment" }, 503);
  }

  const base = environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const configResult = await admin.from("billing_provider_config")
    .select("environment,webhook_id")
    .eq("provider", "paypal")
    .maybeSingle();
  if (configResult.error || !configResult.data || configResult.data.environment !== environment || !configResult.data.webhook_id) {
    return response({ error: "PayPal webhook is not configured" }, 503);
  }

  const token = await getToken(base, clientId, clientSecret);
  const verification = await paypalRequest(base, token, "/v1/notifications/verify-webhook-signature", "POST", {
    auth_algo: req.headers.get("paypal-auth-algo"),
    cert_url: req.headers.get("paypal-cert-url"),
    transmission_id: req.headers.get("paypal-transmission-id"),
    transmission_sig: req.headers.get("paypal-transmission-sig"),
    transmission_time: req.headers.get("paypal-transmission-time"),
    webhook_id: configResult.data.webhook_id,
    webhook_event: event,
  });
  if (verification.verification_status !== "SUCCESS") {
    return response({ error: "Webhook signature verification failed" }, 400);
  }

  const eventId = String(event?.id || "");
  const eventType = String(event?.event_type || "");
  if (!eventId || !eventType) return response({ error: "Missing event id or event type" }, 400);

  const insertResult = await admin.from("billing_events").insert({
    provider: "paypal",
    provider_event_id: eventId,
    event_type: eventType,
    processing_status: "received",
    event_payload: event,
  }).select("id").single();

  let logId = insertResult.data?.id || null;
  if (insertResult.error) {
    if (insertResult.error.code !== "23505") throw new Error("Could not record PayPal event.");
    const previousResult = await admin.from("billing_events")
      .select("id,processing_status")
      .eq("provider", "paypal")
      .eq("provider_event_id", eventId)
      .maybeSingle();
    if (previousResult.error || !previousResult.data) throw new Error("Could not inspect a repeated PayPal event.");
    if (previousResult.data.processing_status === "processed") {
      return response({ received: true, duplicate: true });
    }
    logId = previousResult.data.id;
    await admin.from("billing_events").update({
      processing_status: "received",
      error_message: null,
    }).eq("id", logId);
  }

  const resource = event.resource || {};
  let subscriptionId = "";
  if (eventType.startsWith("BILLING.SUBSCRIPTION.")) {
    subscriptionId = String(resource.id || "");
  } else if (eventType.startsWith("PAYMENT.SALE.")) {
    subscriptionId = String(resource.billing_agreement_id || resource.subscription_id || "");
  }

  let companyId: string | null = null;
  let baseSubscriptionId: string | null = null;

  if (subscriptionId) {
    const coreResult = await admin.from("subscriptions")
      .select("id,company_id,plan_code,status,trial_starts_at,trial_ends_at,current_period_start,current_period_end,paypal_pending_plan_code")
      .eq("provider", "paypal")
      .eq("provider_subscription_id", subscriptionId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const aiResult = await admin.from("company_ai_subscriptions")
      .select("company_id,status,current_period_start,current_period_end")
      .eq("provider", "paypal")
      .eq("provider_subscription_id", subscriptionId)
      .maybeSingle();
    if (coreResult.error || aiResult.error) throw new Error("Could not locate SHINKA subscription.");
    const core = coreResult.data;
    const ai = aiResult.data;
    companyId = core?.company_id || ai?.company_id || null;
    baseSubscriptionId = core?.id || null;

    const needsDetails = eventType === "BILLING.SUBSCRIPTION.ACTIVATED"
      || eventType === "BILLING.SUBSCRIPTION.UPDATED"
      || eventType === "PAYMENT.SALE.COMPLETED";
    let details: any = null;
    if (needsDetails) {
      details = await paypalRequest(base, token, "/v1/billing/subscriptions/" + encodeURIComponent(subscriptionId));
    }

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED" || eventType === "BILLING.SUBSCRIPTION.UPDATED") {
      if (!details) throw new Error("Missing PayPal subscription details.");

      if (core) {
        const mapResult = await admin.from("plan_catalog")
          .select("plan_code")
          .eq("paypal_plan_id", String(details.plan_id || ""))
          .eq("paypal_environment", environment)
          .maybeSingle();
        if (mapResult.error) throw new Error("Could not map the PayPal plan to SHINKA.");
        const mappedPlan = mapResult.data;
        const scheduled = !!iso(details.start_time)
          && new Date(String(details.start_time)).getTime() > Date.now() + 60_000;
        const trialOngoing = core.status === "trialing"
          && !!core.trial_ends_at
          && new Date(core.trial_ends_at).getTime() > Date.now();
        const values: Record<string, unknown> = {
          status: core.status === "active" ? "active" : (trialOngoing || scheduled ? "trialing" : "incomplete"),
          provider_customer_id: details.subscriber?.payer_id || null,
          provider_approval_url: null,
          updated_at: new Date().toISOString(),
        };
        if (scheduled && !core.trial_ends_at) {
          const futureStart = iso(details.start_time);
          values.trial_starts_at = new Date().toISOString();
          values.trial_ends_at = futureStart;
          values.current_period_start = futureStart;
          values.current_period_end = futureStart;
        }
        if (mappedPlan?.plan_code && mappedPlan.plan_code !== core.plan_code) {
          values.paypal_pending_plan_code = mappedPlan.plan_code;
        }
        const updateResult = await admin.from("subscriptions").update(values).eq("id", core.id);
        if (updateResult.error) throw new Error("Could not save SHINKA subscription approval.");
      } else if (ai) {
        const updateResult = await admin.from("company_ai_subscriptions").update({
          status: ai.status === "active" ? "active" : "incomplete",
          provider_customer_id: details.subscriber?.payer_id || null,
          provider_approval_url: null,
          updated_at: new Date().toISOString(),
        }).eq("company_id", ai.company_id);
        if (updateResult.error) throw new Error("Could not save SHINKA IA approval.");
      }
    } else if (eventType === "PAYMENT.SALE.COMPLETED" && details) {
      const paidAt = iso(resource.create_time || resource.update_time || details.billing_info?.last_payment?.time)
        || new Date().toISOString();
      const nextPeriodEnd = iso(details.billing_info?.next_billing_time);

      if (core) {
        const previousEnd = iso(core.current_period_end);
        const trialEnd = iso(core.trial_ends_at);
        const paidMs = new Date(paidAt).getTime();
        const firstPayment = core.status === "incomplete"
          || (core.status === "trialing" && !!trialEnd && paidMs >= new Date(trialEnd).getTime() - 60_000);
        const renewal = ["active", "past_due"].includes(core.status)
          && !!previousEnd
          && paidMs >= new Date(previousEnd).getTime() - 12 * 60 * 60 * 1000;

        if (firstPayment || renewal) {
          const mapResult = await admin.from("plan_catalog")
            .select("plan_code,monthly_price_cents,currency")
            .eq("paypal_plan_id", String(details.plan_id || ""))
            .eq("paypal_environment", environment)
            .maybeSingle();
          if (mapResult.error) throw new Error("Could not map payment to a SHINKA plan.");
          const mappedPlan = mapResult.data;
          const periodStart = renewal && previousEnd ? previousEnd : paidAt;
          const updateResult = await admin.from("subscriptions").update({
            status: "active",
            plan_code: mappedPlan?.plan_code || core.paypal_pending_plan_code || core.plan_code,
            paypal_pending_plan_code: null,
            unit_amount_cents: mappedPlan?.monthly_price_cents,
            currency: mappedPlan?.currency || "USD",
            current_period_start: periodStart,
            current_period_end: nextPeriodEnd || addMonth(periodStart),
            trial_starts_at: null,
            trial_ends_at: null,
            provider_approval_url: null,
            updated_at: new Date().toISOString(),
          }).eq("id", core.id);
          if (updateResult.error) throw new Error("Could not activate or renew SHINKA subscription.");
        }
      } else if (ai) {
        const previousEnd = iso(ai.current_period_end);
        const paidMs = new Date(paidAt).getTime();
        const firstPayment = ["incomplete", "trialing", "past_due"].includes(ai.status) && !previousEnd;
        const renewal = ["active", "past_due"].includes(ai.status)
          && !!previousEnd
          && paidMs >= new Date(previousEnd).getTime() - 12 * 60 * 60 * 1000;
        if (firstPayment || renewal) {
          const periodStart = renewal && previousEnd ? previousEnd : paidAt;
          const updateResult = await admin.from("company_ai_subscriptions").update({
            status: "active",
            current_period_start: periodStart,
            current_period_end: nextPeriodEnd || addMonth(periodStart),
            provider_approval_url: null,
            updated_at: new Date().toISOString(),
          }).eq("company_id", ai.company_id);
          if (updateResult.error) throw new Error("Could not activate or renew SHINKA IA.");
        }
      }
    } else if (eventType === "BILLING.SUBSCRIPTION.CANCELLED") {
      if (core) {
        const trialThrough = core.status === "trialing"
          && core.trial_ends_at
          && new Date(core.trial_ends_at).getTime() > Date.now();
        const paidThrough = core.current_period_end
          && new Date(core.current_period_end).getTime() > Date.now()
          && core.status !== "incomplete";
        const keepAccess = !!trialThrough || !!paidThrough;
        const updateResult = await admin.from("subscriptions").update({
          status: trialThrough ? "trialing" : (paidThrough ? "active" : "canceled"),
          cancel_at_period_end: keepAccess,
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", core.id);
        if (updateResult.error) throw new Error("Could not save SHINKA cancellation.");
      } else if (ai) {
        const paidThrough = ai.current_period_end && new Date(ai.current_period_end).getTime() > Date.now();
        const updateResult = await admin.from("company_ai_subscriptions").update({
          status: paidThrough ? "active" : "canceled",
          cancel_at_period_end: !!paidThrough,
          canceled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("company_id", ai.company_id);
        if (updateResult.error) throw new Error("Could not save SHINKA IA cancellation.");
      }
    } else if (eventType === "BILLING.SUBSCRIPTION.SUSPENDED" || eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
      const nextStatus = eventType === "BILLING.SUBSCRIPTION.SUSPENDED" ? "paused" : "past_due";
      if (core) {
        const updateResult = await admin.from("subscriptions").update({ status: nextStatus, updated_at: new Date().toISOString() }).eq("id", core.id);
        if (updateResult.error) throw new Error("Could not update SHINKA subscription status.");
      } else if (ai) {
        const updateResult = await admin.from("company_ai_subscriptions").update({ status: nextStatus, updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
        if (updateResult.error) throw new Error("Could not update SHINKA IA subscription status.");
      }
    } else if (eventType === "BILLING.SUBSCRIPTION.EXPIRED") {
      if (core) {
        const updateResult = await admin.from("subscriptions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("id", core.id);
        if (updateResult.error) throw new Error("Could not expire SHINKA subscription.");
      } else if (ai) {
        const updateResult = await admin.from("company_ai_subscriptions").update({ status: "expired", updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
        if (updateResult.error) throw new Error("Could not expire SHINKA IA subscription.");
      }
    } else if (eventType === "PAYMENT.SALE.REFUNDED" || eventType === "PAYMENT.SALE.REVERSED") {
      if (core) {
        const updateResult = await admin.from("subscriptions").update({ status: "past_due", updated_at: new Date().toISOString() }).eq("id", core.id);
        if (updateResult.error) throw new Error("Could not update refunded SHINKA subscription.");
      } else if (ai) {
        const updateResult = await admin.from("company_ai_subscriptions").update({ status: "past_due", updated_at: new Date().toISOString() }).eq("company_id", ai.company_id);
        if (updateResult.error) throw new Error("Could not update refunded SHINKA IA subscription.");
      }
    }
  }

  if (logId) {
    const logResult = await admin.from("billing_events").update({
      company_id: companyId,
      subscription_id: baseSubscriptionId,
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    }).eq("id", logId);
    if (logResult.error) throw new Error("Could not finalize the PayPal event log.");
  }

  return response({ received: true, processed: true, ignored: !subscriptionId });
});
