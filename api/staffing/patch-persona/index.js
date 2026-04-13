/**
 * POST /api/staffing/patch-persona
 *
 * One-shot endpoint that PATCHes the existing Jordan v2.0 persona on Tavus.
 * Updates:
 *   1. /layers/perception — v2.0 Raven-1 perception queries
 *   2. /conversation_rules — v2.0 objectives (10) + guardrails (8)
 *      (Currently returns 'Unknown field' — Tavus enforces via system_prompt
 *       until they ship conversation_rules support. Code stays ready.)
 *
 * Run once after deploy:
 *   curl -X POST https://YOUR_DOMAIN/api/staffing/patch-persona
 *
 * Response: { ok, persona_id, patched_fields, warnings }
 */

const { patchPersona } = require("../../../shared/tavus-client");
const { config } = require("../../../staffing/config/staffing-config");

// Pull v2.0 objectives and guardrails from the canonical staffing-config
const JORDAN_OBJECTIVES = config.objectives;
const JORDAN_GUARDRAILS = config.guardrails;

// v2.0 Perception — updated queries, visual_tools emptied (removed
// flag_unprofessional_setting per appearance_bias_prevention guardrail)
const JORDAN_PERCEPTION_V2 = {
  perception_model: "raven-1",
  visual_awareness_queries: [
    "Does the candidate appear calm, nervous, or confident?",
    "Is the candidate maintaining eye contact with the camera?",
    "Is the candidate alone in the frame?",
  ],
  audio_awareness_queries: [
    "Does the candidate sound confident, hesitant, or disengaged?",
    "Is the candidate speaking clearly and at a natural pace?",
  ],
  perception_analysis_queries: [
    "Did the candidate's engagement and energy increase, decrease, or stay flat throughout the session?",
    "Were there moments where the candidate appeared visibly uncomfortable or evasive — if so, at what point in the conversation?",
    "Was the candidate alone during the entire interview, or was anyone else present at any point?",
    "On a scale of 1-10, rate the candidate's overall communication clarity and confidence across the full session.",
    "Summarize the candidate's emotional arc across the interview in 2-3 sentences.",
  ],
  visual_tools: [],
  visual_tool_prompt: "",
  audio_tool_prompt:
    "You have two audio-triggered tools. Use candidate_strong_signal when a candidate sounds confident, articulate, and genuinely enthusiastic across multiple answers — this flags them for recruiter priority review. Use escalate_to_recruiter if the candidate becomes visibly or audibly distressed, discloses a protected characteristic that the AI must not explore, becomes confused about the interview process, or encounters any situation requiring human follow-up.",
  audio_tools: [
    {
      type: "function",
      function: {
        name: "candidate_strong_signal",
        parameters: {
          type: "object",
          required: ["standout_moment"],
          properties: {
            standout_moment: {
              type: "string",
              maxLength: 300,
              description:
                "The specific answer or moment that most stood out positively — what they said and why it indicates strong fit",
            },
          },
        },
        description:
          "Trigger when candidate consistently sounds confident, articulate, and enthusiastic across multiple answers — indicates strong pipeline signal for recruiter priority review",
      },
    },
    {
      type: "function",
      function: {
        name: "escalate_to_recruiter",
        parameters: {
          type: "object",
          required: ["reason"],
          properties: {
            reason: {
              type: "string",
              maxLength: 300,
              description:
                "Why escalation is needed — candidate distress, protected class disclosure, technical issue, or situation requiring human judgment",
            },
          },
        },
        description:
          "Trigger when candidate is distressed, discloses protected info, or encounters situation requiring human follow-up",
      },
    },
  ],
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const personaId = process.env.TAVUS_STAFFING_PERSONA_ID;
  if (!personaId) {
    res.status(500).json({ error: "TAVUS_STAFFING_PERSONA_ID not set" });
    return;
  }
  if (!process.env.TAVUS_API_KEY) {
    res.status(500).json({ error: "TAVUS_API_KEY not set" });
    return;
  }

  const baseUrl =
    process.env.STAFFING_BASE_URL ||
    `https://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
  const callbackUrl = `${baseUrl}/api/staffing/tools`;

  const result = {
    ok: true,
    persona_id: personaId,
    version: "2.0",
    callback_url: callbackUrl,
    patched_fields: [],
    warnings: [],
    jordan_objectives_count: JORDAN_OBJECTIVES.length,
    jordan_guardrails_count: JORDAN_GUARDRAILS.length,
  };

  // ── Patch perception ────────────────────────────────────────────
  try {
    await patchPersona(personaId, [
      { op: "add", path: "/layers/perception", value: JORDAN_PERCEPTION_V2 },
    ]);
    result.patched_fields.push("perception_v2");
  } catch (e) {
    result.ok = false;
    result.perception_error = e.message;
  }

  // ── Attempt conversation_rules ──────────────────────────────────
  // Tavus currently returns "Unknown field" for /conversation_rules.
  // Objectives and guardrails are enforced via the system_prompt on
  // the persona. This code stays ready for when Tavus ships native
  // conversation_rules support.
  const guardrailsWithCallback = JORDAN_GUARDRAILS.map((g) => ({
    ...g,
    callback_url: callbackUrl,
  }));

  try {
    await patchPersona(personaId, [
      {
        op: "add",
        path: "/conversation_rules",
        value: {
          objectives: JORDAN_OBJECTIVES,
          guardrails: guardrailsWithCallback,
        },
      },
    ]);
    result.patched_fields.push("objectives_v2", "guardrails_v2");
  } catch (e) {
    result.warnings.push(
      "conversation_rules not accepted by Tavus API — objectives/guardrails enforced via system_prompt. " +
        e.message.slice(0, 200)
    );
  }

  res.status(result.ok ? 200 : 500).json(result);
};
