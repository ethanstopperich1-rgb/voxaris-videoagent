/**
 * POST /api/staffing/conversations
 *
 * Creates a Tavus CVI screening session for a candidate applying to a role.
 *
 * Body (minimum — backward compat with existing staffing-embed.html):
 *   { candidate_name, role, agency_name, language }
 *
 * Body (full — from the new /apply pre-interview form):
 *   {
 *     candidate_name,
 *     role,
 *     agency_name,
 *     // Pre-interview form fields:
 *     email,
 *     phone,
 *     years_experience,        // "0-1" | "1-3" | "3-5" | "5-10" | "10+"
 *     most_recent_employer,
 *     resume_text,             // Plain text extracted client-side with pdf.js
 *     consent_given,           // Must be true — request is rejected otherwise
 *     consent_timestamp        // ISO timestamp from the client
 *   }
 *
 * When resume_text + email + phone arrive, they get injected into the Tavus
 * conversational_context so Jordan opens the interview already knowing who
 * she's talking to and can skip the "what's your name / what's your email"
 * step entirely — going straight into work auth, experience verification,
 * and role-specific questions. The `save_candidate_screening` tool on the
 * persona still captures structured data for the recruiter.
 *
 * Response:
 *   { ok, conversation_id, conversation_url, role, role_details, status }
 */

const https = require("https");
const { config } = require("../../../staffing/config/staffing-config");
const { buildRoleContext } = require("../../../staffing/lib/role-context");
const { putSession } = require("../../../shared/google-sheets");

const TAVUS_HOST = "tavusapi.com";
const MAX_RESUME_CHARS = 12000; // safety cap on resume text injection

function tavusCreate(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: TAVUS_HOST,
        path: "/v2/conversations",
        method: "POST",
        headers: {
          "x-api-key": process.env.TAVUS_API_KEY || "",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json",
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const status = res.statusCode || 0;
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = { raw };
          }
          if (status >= 200 && status < 300) resolve(parsed);
          else {
            const err = new Error(`Tavus create conversation ${status}: ${raw}`);
            err.status = status;
            err.body = parsed;
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Build a rich candidate profile context block to prepend onto the role
 * context string. Only appends fields that were actually provided.
 */
function buildCandidateBrief(body) {
  const {
    candidate_name,
    email,
    phone,
    years_experience,
    most_recent_employer,
    resume_text,
    consent_given,
    consent_timestamp,
  } = body;

  const parts = ["CANDIDATE PROFILE (captured pre-interview from apply form):"];

  if (candidate_name) parts.push(`Name: ${candidate_name}`);
  if (email) parts.push(`Email: ${email}`);
  if (phone) parts.push(`Phone: ${phone}`);
  if (years_experience) parts.push(`Years of experience: ${years_experience}`);
  if (most_recent_employer)
    parts.push(`Most recent employer: ${most_recent_employer}`);
  if (consent_given === true && consent_timestamp) {
    parts.push(`Consent captured: ${consent_timestamp} (checkbox at apply time)`);
  }

  if (resume_text && typeof resume_text === "string") {
    const truncated = resume_text.slice(0, MAX_RESUME_CHARS);
    parts.push("", "RESUME CONTENT (extracted from PDF, text only):");
    parts.push(truncated);
    if (resume_text.length > MAX_RESUME_CHARS) {
      parts.push(`[TRUNCATED: resume was ${resume_text.length} chars, showing first ${MAX_RESUME_CHARS}]`);
    }
  }

  parts.push(
    "",
    "INSTRUCTIONS FOR JORDAN:",
    "- You already have the candidate's name, email, phone, and resume above. Do NOT re-ask for them.",
    "- Use the resume content to personalize the interview — reference specific roles, certifications, or accomplishments you see on it.",
    "- Proceed directly from the disclosure + consent step into work authorization and experience verification.",
    "- When you confirm structured data in conversation, call the `save_candidate_screening` tool to log it for the recruiter."
  );

  return parts.join("\n");
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!config.apiKey || !config.personaId || !config.replicaId) {
    res.status(500).json({
      error: "Staffing vertical not configured",
      missing: {
        TAVUS_API_KEY: !config.apiKey,
        TAVUS_STAFFING_PERSONA_ID: !config.personaId,
        TAVUS_STAFFING_REPLICA_ID: !config.replicaId,
      },
    });
    return;
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};
    const {
      candidate_name = "there",
      role = "general",
      agency_name = "our staffing team",
      // Pre-interview form fields (optional for legacy flows)
      email,
      phone,
      years_experience,
      most_recent_employer,
      resume_text,
      consent_given,
      consent_timestamp,
    } = body;

    // If the request came from the /apply pre-interview form, consent MUST
    // be explicitly true. Reject otherwise — this is the legal gate.
    const cameFromApplyForm = !!(email || phone || resume_text);
    if (cameFromApplyForm && consent_given !== true) {
      res.status(400).json({
        ok: false,
        error:
          "Consent required. The apply form must submit consent_given=true and a consent_timestamp before an interview can start.",
      });
      return;
    }

    const baseUrl =
      process.env.STAFFING_BASE_URL ||
      `https://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
    const callbackUrl = `${baseUrl}/api/staffing/tools`;

    const { contextString: roleContext, role: roleData } = buildRoleContext(
      role,
      candidate_name,
      agency_name
    );

    // Build the candidate brief first so it appears at the top of the
    // conversational_context — Jordan reads top-down and the candidate
    // profile should be the first thing she encounters.
    const candidateBrief = cameFromApplyForm
      ? buildCandidateBrief({
          candidate_name,
          email,
          phone,
          years_experience,
          most_recent_employer,
          resume_text,
          consent_given,
          consent_timestamp,
        })
      : null;

    const fullContext = candidateBrief
      ? `${candidateBrief}\n\n---\n\n${roleContext}`
      : roleContext;

    const greeting = `Hey ${candidate_name}! Thanks so much for taking the time — I'm Jordan, and I'll be doing your pre-screening today for the ${roleData.title} role with ${agency_name}. This should take about 10 minutes and it's really just a conversation, so feel free to be yourself. Sound good?`;

    const tavusBody = {
      persona_id: config.personaId,
      replica_id: config.replicaId,
      conversation_name: `Jordan Screen – ${candidate_name} – ${roleData.title}`,
      custom_greeting: greeting,
      conversational_context: fullContext,
      callback_url: callbackUrl,
      // Tavus 2026 security upgrade — require_auth makes the WebRTC room
      // private and returns a short-lived meeting_token the client must
      // append to the URL. Without this, the conversation_url is a public
      // gateway and anyone with the link can join the live candidate session.
      require_auth: true,
      properties: { ...config.conversationDefaults },
    };

    const tavus = await tavusCreate(tavusBody);
    const conversationId = tavus.conversation_id;
    // With require_auth: true, Tavus returns conversation_url + meeting_token
    // separately. Daily.js `join()` expects them as separate params
    // ({ url, token }), NOT concatenated as a query string — passing
    // `https://room?t=TOKEN` to Daily fails silently and the join errors
    // out. We therefore return them as two fields and let the client pass
    // them through cleanly.
    const conversationUrl = tavus.conversation_url;
    const meetingToken = tavus.meeting_token || null;

    const seed = {
      conversation_id: conversationId,
      vertical: "staffing",
      candidate_name,
      applied_role: roleData.title,
      role_key: role,
      agency_name,
      // Pre-interview capture:
      email: email || null,
      phone: phone || null,
      years_experience: years_experience || null,
      most_recent_employer: most_recent_employer || null,
      consent_given: consent_given === true,
      consent_timestamp: consent_timestamp || null,
      resume_uploaded: !!(resume_text && resume_text.length > 0),
      resume_length: resume_text ? resume_text.length : 0,
      came_from_apply_form: cameFromApplyForm,
      started_at: new Date().toISOString(),
      objectives_completed: [],
    };
    try {
      await putSession(conversationId, seed);
    } catch (e) {
      console.warn("putSession seed failed:", e.message);
    }

    res.status(200).json({
      ok: true,
      conversation_id: conversationId,
      conversation_url: conversationUrl,
      meeting_token: meetingToken,
      role: roleData.title,
      role_details: {
        key: role,
        title: roleData.title,
        venue_type: roleData.venue_type,
        pay_range: roleData.pay_range,
        shift: roleData.shift,
        must_haves: roleData.must_haves,
      },
      candidate_name,
      agency_name,
      pre_interview_captured: cameFromApplyForm,
      status: tavus.status || "created",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, body: e.body });
  }
};
