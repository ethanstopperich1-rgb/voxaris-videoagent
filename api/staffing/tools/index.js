/**
 * /api/staffing/tools — Tavus webhook + frontend poll for the staffing vertical.
 *
 * GET  ?conversation_id=xxx  → current session state
 * POST                        → webhook router for:
 *   - Format A: legacy tool calls (updateCandidateProfile, scheduleRecruiterCall)
 *   - Format B: lifecycle events (conversation.ended)
 *   - Format C: objective callbacks (Jordan's primary data flow)
 *   - Format D: guardrail triggers
 *
 * Terminal flow:
 *   - objective "end_screening_ineligible" → mark disqualified, log, do not route
 *   - objective "closing_confirmed"        → fire N8N_INTERVIEW_WEBHOOK, log
 */

const {
  putSession,
  getSession,
  pushDlq,
} = require("../../../shared/session-store");
const { triggerN8n } = require("../../../shared/n8n-trigger");
const { logStaffingSession } = require("../../../staffing/lib/sheets-logger");
const { verifyWebhook } = require("../../../shared/webhook-verify");

// Fields the persona is allowed to save via updateCandidateProfile. Anything
// outside this allowlist gets stripped before we merge into the session so a
// hallucinated tool arg can't overwrite conversation_id or status.
// Fields the persona is allowed to save via save_candidate_screening.
// v2.0 additions: narrative_summary, fit_signal, behavioral_response_quality,
// contact_phone, contact_email (from objectives output_variables).
const ALLOWED_CANDIDATE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "contact_phone",
  "contact_email",
  "work_authorized",
  "years_experience",
  "most_recent_employer",
  "certifications",
  "has_certification",
  "certification_name",
  "available_evenings",
  "available_weekends",
  "earliest_start_date",
  "confirmed_physical_requirements",
  "narrative_summary",
  "fit_signal",
  "behavioral_response_quality",
  "notes",
  "disqualified",
];

// Fields allowed for save_partial_screening (incomplete sessions).
const ALLOWED_PARTIAL_FIELDS = [
  "full_name",
  "phone",
  "email",
  "reason_incomplete",
  "data_collected",
  "notes",
];

async function handleGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
    for (const v of outputVariables) {
      if (v && v.name) merged[v.name] = v.value;
    }
  } else if (outputVariables && typeof outputVariables === "object") {
    Object.assign(merged, outputVariables);
  }
  return merged;
}

function coerceBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "y") return true;
    if (lower === "false" || lower === "no" || lower === "n") return false;
  }
  return null;
}

async function processWebhookAsync(payload) {
  const conversationId =
    payload.conversation_id || payload.conversationId || null;
  if (!conversationId) return;

  // Tavus 2026 Interactions Protocol — seq is a globally monotonic
  // sequence number for out-of-order event reconciliation; turn_idx
  // groups all events within the same conversational turn. Gemini
  // audit finding: these must be captured for legally defensible
  // chronological reconstruction.
  const seq = payload.seq ?? null;
  const turnIdx = payload.turn_idx ?? null;

  const existing = (await getSession(conversationId)) || {
    conversation_id: conversationId,
    vertical: "staffing",
    objectives_completed: [],
    event_log: [],
  };

  // Append this event to a lightweight per-session event log so the
  // seq+turn_idx ordering is auditable later.
  const eventLog = Array.isArray(existing.event_log) ? existing.event_log : [];
  if (seq !== null) {
    eventLog.push({
      seq,
      turn_idx: turnIdx,
      event_type: payload.event_type || payload.objective_name || payload.tool_name || payload.guardrail_name || "unknown",
      received_at: new Date().toISOString(),
    });
    existing.event_log = eventLog.slice(-50); // cap at last 50 events per session
  }

  // Format B — lifecycle
  const eventType = payload.event_type || payload.type;
  if (eventType === "conversation.ended" || eventType === "conversation_ended") {
    const finalSession = {
      ...existing,
      ended_at: new Date().toISOString(),
      status: existing.status || "ended",
    };
    await putSession(conversationId, finalSession);
    await logStaffingSession(finalSession);
    return;
  }

  // Format D — guardrail
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

    // Normalize work_authorized
    if (merged.work_authorized !== undefined) {
      const coerced = coerceBool(merged.work_authorized);
      if (coerced !== null) merged.work_authorized = coerced;
    }

    const completed = Array.isArray(merged.objectives_completed)
      ? merged.objectives_completed
      : [];
    if (!completed.includes(payload.objective_name)) {
      completed.push(payload.objective_name);
    }
    merged.objectives_completed = completed;
    merged.last_objective = payload.objective_name;

    // v2.0: graceful no-consent close — candidate declined AI interview
    if (payload.objective_name === "graceful_no_consent_close") {
      merged.status = "consent_declined";
      merged.completed_at = new Date().toISOString();
      await putSession(conversationId, merged);
      await logStaffingSession(merged);
      return;
    }

    // Disqualified branch (v1 legacy + v2.0 work_authorization denial)
    if (payload.objective_name === "end_screening_ineligible") {
      merged.disqualified = true;
      merged.status = "disqualified";
      merged.completed_at = new Date().toISOString();
      await putSession(conversationId, merged);
      await logStaffingSession(merged);
      // Still notify n8n so recruiter can see the attempt
      await triggerN8n(process.env.N8N_INTERVIEW_WEBHOOK, {
        disqualified: true,
        reason: "work_authorization",
        full_name: merged.full_name || merged.candidate_name || "",
        email: merged.email || "",
        applied_role: merged.applied_role || "",
        conversation_id: conversationId,
      });
      return;
    }

    // v2.0: warm_close is the new terminal success objective
    if (payload.objective_name === "warm_close") {
      merged.recruiter_call_scheduled = true;
      merged.status = "completed";
      merged.completed_at = new Date().toISOString();
      await putSession(conversationId, merged);
      await triggerN8n(process.env.N8N_INTERVIEW_WEBHOOK, {
        disqualified: false,
        full_name: merged.full_name || merged.candidate_name || "",
        email: merged.email || merged.contact_email || "",
        phone: merged.phone || merged.contact_phone || "",
        work_authorized: merged.work_authorized || "",
        years_experience: merged.years_experience || "",
        most_recent_employer: merged.most_recent_employer || "",
        certifications: merged.certifications || [],
        available_evenings: merged.available_evenings || false,
        available_weekends: merged.available_weekends || false,
        earliest_start_date: merged.earliest_start_date || "",
        confirmed_physical_requirements:
          merged.confirmed_physical_requirements || false,
        narrative_summary: merged.narrative_summary || "",
        fit_signal: merged.fit_signal || "",
        behavioral_response_quality: merged.behavioral_response_quality || "",
        conversation_id: conversationId,
      });
      await logStaffingSession(merged);
      return;
    }

    // Terminal success (v1 legacy — keep for backward compat)
    if (payload.objective_name === "closing_confirmed") {
      merged.recruiter_call_scheduled = true;
      merged.status = "completed";
      merged.completed_at = new Date().toISOString();
      await putSession(conversationId, merged);
      await triggerN8n(process.env.N8N_INTERVIEW_WEBHOOK, {
        disqualified: false,
        full_name: merged.full_name || merged.candidate_name || "",
        email: merged.email || "",
        phone: merged.phone || "",
        applied_role: merged.applied_role || "",
        years_experience: merged.years_experience || "",
        venue_type: merged.venue_type || "",
        most_recent_employer: merged.most_recent_employer || "",
        has_certification: merged.has_certification || false,
        certification_name: merged.certification_name || "",
        available_evenings: merged.available_evenings || false,
        available_weekends: merged.available_weekends || false,
        earliest_start_date: merged.earliest_start_date || "",
        confirmed_physical_requirements:
          merged.confirmed_physical_requirements || false,
        candidate_question_1: merged.candidate_question_1 || "",
        candidate_question_2: merged.candidate_question_2 || "",
        preferred_callback_time: merged.preferred_callback_time || "",
        conversation_id: conversationId,
      });
      await logStaffingSession(merged);
      return;
    }

    await putSession(conversationId, merged);
    return;
  }

  // Format A — tool calls (save_candidate_screening, scheduleRecruiterCall, legacy updateCandidateProfile)
  if (payload.tool_name) {
    const { sendToolResult } = require("../../../shared/tavus-client");
    const rawParams = payload.parameters || payload.arguments || {};

    // Allowlist filter — strip anything the persona isn't allowed to set
    // directly so a hallucinated arg can't overwrite conversation_id, status,
    // event_log, etc. Anything outside ALLOWED_CANDIDATE_FIELDS is dropped.
    const params = {};
    const fieldsSaved = [];
    for (const k of Object.keys(rawParams)) {
      if (ALLOWED_CANDIDATE_FIELDS.includes(k)) {
        params[k] = rawParams[k];
        fieldsSaved.push(k);
      }
    }
    // Coerce work_authorized to a real boolean-ish value
    if (params.work_authorized !== undefined) {
      const coerced = coerceBool(params.work_authorized);
      if (coerced !== null) params.work_authorized = coerced;
    }
    const merged = { ...existing, ...params };

    if (
      payload.tool_name === "save_candidate_screening" ||
      payload.tool_name === "updateCandidateProfile"
    ) {
      // Disqualification branch — ineligible work auth is terminal.
      if (merged.work_authorized === false || merged.disqualified === true) {
        merged.disqualified = true;
        merged.status = "disqualified";
        merged.completed_at = new Date().toISOString();
        await Promise.all([
          putSession(conversationId, merged),
          sendToolResult(conversationId, payload.tool_call_id, {
            success: true,
            fields_saved: fieldsSaved,
            next_action: "end_screening_ineligible",
            message:
              "I hear you — thanks for being upfront. Unfortunately we can only move forward with US-authorized candidates, so I'm going to wrap up here.",
          }),
        ]);
        return;
      }
      await Promise.all([
        putSession(conversationId, merged),
        sendToolResult(conversationId, payload.tool_call_id, {
          success: true,
          fields_saved: fieldsSaved,
          next_action: "continue_screening",
          message: `Got it — saved ${fieldsSaved.length} field${fieldsSaved.length === 1 ? "" : "s"}. Keep going with the next question.`,
        }),
      ]);
      return;
    }

    // v2.0: save_partial_screening — incomplete sessions (disconnect, timeout, etc.)
    if (payload.tool_name === "save_partial_screening") {
      const partialParams = {};
      const partialFieldsSaved = [];
      for (const k of Object.keys(rawParams)) {
        if (ALLOWED_PARTIAL_FIELDS.includes(k)) {
          partialParams[k] = rawParams[k];
          partialFieldsSaved.push(k);
        }
      }
      const partialMerged = {
        ...existing,
        ...partialParams,
        status: "incomplete",
        reason_incomplete: partialParams.reason_incomplete || "unknown",
        completed_at: new Date().toISOString(),
      };
      await Promise.all([
        putSession(conversationId, partialMerged),
        sendToolResult(conversationId, payload.tool_call_id, {
          success: true,
          fields_saved: partialFieldsSaved,
          next_action: "end_session",
          message: "Partial screening data saved. Session marked as incomplete.",
        }),
      ]);
      await logStaffingSession(partialMerged);
      return;
    }

    if (payload.tool_name === "scheduleRecruiterCall") {
      merged.recruiter_call_scheduled = true;
      merged.status = "completed";
      merged.completed_at = new Date().toISOString();
      await Promise.all([
        putSession(conversationId, merged),
        triggerN8n(process.env.N8N_INTERVIEW_WEBHOOK, {
          ...merged,
          conversation_id: conversationId,
        }),
        sendToolResult(conversationId, payload.tool_call_id, {
          success: true,
          fields_saved: fieldsSaved,
          next_action: "closing_confirmed",
          message:
            "You're all set — a recruiter will reach out within 1 business day. Thanks for your time today, and best of luck!",
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
    console.warn("[staffing/tools] webhook signature rejected:", verification.reason);
    res.status(401).json({ ok: false, reason: verification.reason });
    return;
  }
  if (verification.reason === "no-secret-configured") {
    console.warn(
      "[staffing/tools] TAVUS_WEBHOOK_SECRET not configured — accepting unverified webhook. Set the env var in production."
    );
  }

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
    console.error("staffing/tools webhook error:", e.message, e.stack);
    // Push to DLQ so the payload isn't lost permanently
    try {
      const cid = payload.conversation_id || payload.conversationId || null;
      const eventType =
        payload.event_type || payload.objective_name || payload.tool_name || "unknown";
      await pushDlq(cid, "staffing", eventType, payload, e.message);
    } catch (dlqErr) {
      console.error("staffing/tools DLQ push also failed:", dlqErr.message);
    }
  }
};
