/**
 * /api/realty/tools — Tavus webhook + frontend poll endpoint.
 *
 * GET  ?conversation_id=xxx  → returns current session state
 * POST                        → handles Tavus webhook payloads:
 *
 *   Format A (legacy tool call):     { tool_name, tool_call_id, conversation_id, parameters }
 *   Format B (lifecycle event):      { event_type, conversation_id, properties }
 *   Format C (objective callback):   { objective_name, output_variables, conversation_id }
 *   Format D (guardrail trigger):    { guardrail_name, conversation_id, ... }
 *
 * Architecture note: with the Tavus Prompting Playbook persona (Aria), data
 * flows primarily via Format C objective callbacks. Legacy Format A is still
 * accepted so the endpoint stays compatible if you ever add tool definitions.
 *
 * ACK strategy: respond 200 immediately, then do async work. Tavus freezes
 * conversations if the ACK takes longer than ~5 seconds.
 */

const {
  putSession,
  getSession,
} = require("../../../shared/google-sheets");
const { triggerN8n } = require("../../../shared/n8n-trigger");
const { logRealtySession } = require("../../../realty/lib/sheets-logger");
const { verifyWebhook } = require("../../../shared/webhook-verify");

const TERMINAL_OBJECTIVES = new Set(["closing_confirmed"]);
const BOOK_TOUR_OBJECTIVES = new Set(["schedule_agent_call"]);

async function handleGet(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );
  const conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    res.status(400).json({ error: "conversation_id required" });
    return;
  }
  try {
    const session = await getSession(conversationId);
    res.status(200).json({ ok: true, session: session || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

function mergeOutputVariables(session, outputVariables) {
  const merged = { ...(session || {}) };
  if (Array.isArray(outputVariables)) {
    // Legacy shape: [{ name, value }, ...]
    for (const v of outputVariables) {
      if (v && v.name) merged[v.name] = v.value;
    }
  } else if (outputVariables && typeof outputVariables === "object") {
    Object.assign(merged, outputVariables);
  }
  return merged;
}

async function processWebhookAsync(payload) {
  const conversationId =
    payload.conversation_id || payload.conversationId || null;
  if (!conversationId) return;

  const existing = (await getSession(conversationId)) || {
    conversation_id: conversationId,
    vertical: "realty",
    objectives_completed: [],
  };

  // Format B — lifecycle event
  const eventType = payload.event_type || payload.type;
  if (eventType === "conversation.ended" || eventType === "conversation_ended") {
    const finalSession = {
      ...existing,
      ended_at: new Date().toISOString(),
      status: "ended",
    };
    await putSession(conversationId, finalSession);
    await logRealtySession(finalSession);
    return;
  }

  // Format D — guardrail trigger
  if (payload.guardrail_name) {
    const updated = {
      ...existing,
      last_guardrail: payload.guardrail_name,
      last_guardrail_at: new Date().toISOString(),
    };
    await putSession(conversationId, updated);
    return;
  }

  // Format C — objective callback
  if (payload.objective_name) {
    const merged = mergeOutputVariables(existing, payload.output_variables);
    const completed = Array.isArray(merged.objectives_completed)
      ? merged.objectives_completed
      : [];
    if (!completed.includes(payload.objective_name)) {
      completed.push(payload.objective_name);
    }
    merged.objectives_completed = completed;
    merged.last_objective = payload.objective_name;

    await putSession(conversationId, merged);

    // Fire n8n when the buyer has hit the tour-scheduling objective
    if (BOOK_TOUR_OBJECTIVES.has(payload.objective_name)) {
      merged.tour_requested = true;
      await putSession(conversationId, merged);
      await triggerN8n(process.env.N8N_TOUR_BOOKING_WEBHOOK, {
        buyer_name: merged.full_name || merged.visitor_name || "",
        buyer_email: merged.email || "",
        buyer_phone: merged.phone || "",
        listing_id: merged.listing_id || "",
        listing_address: merged.listing_address || "",
        preferred_date: merged.preferred_date || "",
        preferred_time: merged.preferred_time || "",
        tour_type: merged.visit_type || "in-person",
        conversation_id: conversationId,
      });
    }

    // Terminal objective — flush to Realty Sessions tab
    if (TERMINAL_OBJECTIVES.has(payload.objective_name)) {
      merged.status = "completed";
      merged.completed_at = new Date().toISOString();
      await putSession(conversationId, merged);
      await logRealtySession(merged);
    }
    return;
  }

  // Format A — legacy tool call
  if (payload.tool_name) {
    const { sendToolResult } = require("../../../shared/tavus-client");
    const params = payload.parameters || payload.arguments || {};
    const merged = { ...existing, ...params };

    if (payload.tool_name === "updateBuyerProfile") {
      await Promise.all([
        putSession(conversationId, merged),
        sendToolResult(conversationId, payload.tool_call_id, {
          success: true,
          message: "Profile updated.",
        }),
      ]);
      return;
    }

    if (payload.tool_name === "bookTour") {
      merged.tour_requested = true;
      await Promise.all([
        putSession(conversationId, merged),
        triggerN8n(process.env.N8N_TOUR_BOOKING_WEBHOOK, {
          buyer_name: merged.buyer_name || merged.full_name || "",
          buyer_email: merged.buyer_email || merged.email || "",
          buyer_phone: merged.buyer_phone || merged.phone || "",
          listing_id: merged.listing_id || "",
          preferred_date: merged.preferred_date || "",
          preferred_time: merged.preferred_time || "",
          tour_type: merged.tour_type || "in-person",
          conversation_id: conversationId,
        }),
        sendToolResult(conversationId, payload.tool_call_id, {
          success: true,
          message:
            "I've submitted your tour request! You'll receive a confirmation email within a few minutes with the details.",
        }),
      ]);
      return;
    }
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method === "GET") {
    await handleGet(req, res);
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify HMAC webhook signature (Gemini audit finding)
  const verification = verifyWebhook(req);
  if (!verification.ok) {
    console.warn("[realty/tools] webhook signature rejected:", verification.reason);
    res.status(401).json({ ok: false, reason: verification.reason });
    return;
  }
  if (verification.reason === "no-secret-configured") {
    console.warn(
      "[realty/tools] TAVUS_WEBHOOK_SECRET not configured — accepting unverified webhook."
    );
  }

  // ACK immediately, do the work after.
  res.status(200).json({ ok: true });

  let payload;
  try {
    payload =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    payload = {};
  }

  try {
    await processWebhookAsync(payload);
  } catch (e) {
    console.error("realty/tools webhook error:", e.message, e.stack);
  }
};
