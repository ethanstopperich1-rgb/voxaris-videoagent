/**
 * POST /api/realty/conversations
 *
 * Creates a Tavus CVI session for a buyer viewing a specific listing.
 *
 * Body: { visitor_name, listing_id, language, source, brokerage_name }
 * Response: { conversation_id, conversation_url, listing_address, status }
 *
 * Flow:
 *   1. fetch RAG context via SimplyRETS
 *   2. build custom greeting
 *   3. POST to Tavus /v2/conversations with conversation_rules merged in
 *   4. seed Live Sessions row so the frontend polling works immediately
 */

const https = require("https");
const { config } = require("../../../realty/config/realty-config");
const { fetchListingContext } = require("../../../realty/lib/rag");
const { putSession } = require("../../../shared/google-sheets");

const TAVUS_HOST = "tavusapi.com";

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
      error: "Realty vertical not configured",
      missing: {
        TAVUS_API_KEY: !config.apiKey,
        TAVUS_REALTY_PERSONA_ID: !config.personaId,
        TAVUS_REALTY_REPLICA_ID: !config.replicaId,
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
      visitor_name = "there",
      listing_id = "",
      source = "web",
      brokerage_name = "our brokerage",
    } = body;

    const baseUrl =
      process.env.REALTY_BASE_URL ||
      `https://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
    const callbackUrl = `${baseUrl}/api/realty/tools`;

    const { contextString, address, photoMap } = await fetchListingContext(
      listing_id
    );
    const listingAddress = address || `MLS #${listing_id || "unknown"}`;

    const conversationalContext = [
      contextString,
      "",
      `Buyer Name: ${visitor_name}`,
      `Buyer Context: Arrived via ${source}. Has not visited the home in person.`,
      `Brokerage: ${brokerage_name}`,
    ].join("\n");

    const greeting = `Hey ${visitor_name}! I'm Aria. I'm so glad you could join me today — I'm going to walk you through ${listingAddress}, and I'd love to show you what makes this one really special. Feel free to ask me anything as we go. Ready to start?`;

    // Note: Tavus /v2/conversations does NOT accept top-level conversation_rules
    // or properties.apply_conversation_rules in the current API. Objectives and
    // guardrails must live on the persona itself via /v2/personas. We keep the
    // config.buildConversationRules() method around for future persona updates
    // but do not send them here.
    const tavusBody = {
      persona_id: config.personaId,
      replica_id: config.replicaId,
      conversation_name: `Aria Showing – ${listingAddress}`,
      custom_greeting: greeting,
      conversational_context: conversationalContext,
      callback_url: callbackUrl,
      // Tavus 2026 security upgrade — private room with meeting_token.
      require_auth: true,
      properties: { ...config.conversationDefaults },
    };

    const tavus = await tavusCreate(tavusBody);
    const conversationId = tavus.conversation_id;
    const conversationUrl = tavus.meeting_token
      ? `${tavus.conversation_url}?t=${tavus.meeting_token}`
      : tavus.conversation_url;

    // Seed Live Sessions so frontend polling has something to read immediately.
    const seed = {
      conversation_id: conversationId,
      vertical: "realty",
      visitor_name,
      listing_id,
      listing_address: listingAddress,
      source,
      brokerage_name,
      started_at: new Date().toISOString(),
      objectives_completed: [],
      photo_map: JSON.stringify(photoMap || { all: [] }),
    };
    try {
      await putSession(conversationId, seed);
    } catch (e) {
      // Non-fatal — log and continue.
      console.warn("putSession seed failed:", e.message);
    }

    res.status(200).json({
      ok: true,
      conversation_id: conversationId,
      conversation_url: conversationUrl,
      listing_address: listingAddress,
      photo_map: photoMap || { all: [] },
      status: tavus.status || "created",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, body: e.body });
  }
};
