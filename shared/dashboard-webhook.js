/**
 * Forward events to the Voxaris Dashboard webhook.
 *
 * The dashboard at bradnbelew/voxaris-dashboard expects:
 *   POST /api/webhooks/interview
 *   Header: x-webhook-secret: <VOXARIS_WEBHOOK_SECRET>
 *   Body: { organization_id, conversation_id, event_type, data }
 *
 * Event types:
 *   interview_started     — conversation created
 *   objective_completed   — persona objective hit
 *   conversation_ended    — system.shutdown from Tavus
 *   transcript_ready      — application.transcription_ready
 *   recording_ready       — application.recording_ready
 *   perception_ready      — application.perception_analysis
 *   guardrail_triggered   — guardrail fire
 *
 * Env vars:
 *   DASHBOARD_WEBHOOK_URL    — e.g. https://voxaris-dashboard.vercel.app/api/webhooks/interview
 *   DASHBOARD_WEBHOOK_SECRET — must match VOXARIS_WEBHOOK_SECRET on the dashboard
 *   DASHBOARD_ORG_ID         — organization UUID from the dashboard's organizations table
 */

const https = require("https");
const http = require("http");

function getConfig() {
  return {
    url: process.env.DASHBOARD_WEBHOOK_URL || null,
    secret: process.env.DASHBOARD_WEBHOOK_SECRET || "",
    orgId: process.env.DASHBOARD_ORG_ID || "",
  };
}

/**
 * Fire-and-forget POST to the dashboard webhook.
 * Never throws — logs errors and returns { ok, error? }.
 */
async function forwardToDashboard(eventType, conversationId, data = {}) {
  const cfg = getConfig();
  if (!cfg.url) {
    // Dashboard not configured — skip silently
    return { ok: false, error: "DASHBOARD_WEBHOOK_URL not set" };
  }

  const payload = JSON.stringify({
    organization_id: cfg.orgId,
    conversation_id: conversationId,
    event_type: eventType,
    data,
  });

  return new Promise((resolve) => {
    try {
      const parsed = new URL(cfg.url);
      const transport = parsed.protocol === "https:" ? https : http;

      const req = transport.request(
        {
          host: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "x-webhook-secret": cfg.secret,
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            const status = res.statusCode || 0;
            if (status >= 200 && status < 300) {
              console.log(`[dashboard] ${eventType} → ${conversationId} (${status})`);
              resolve({ ok: true, status });
            } else {
              console.error(`[dashboard] ${eventType} failed ${status}: ${raw}`);
              resolve({ ok: false, status, error: raw });
            }
          });
        }
      );
      req.on("error", (e) => {
        console.error(`[dashboard] ${eventType} request error:`, e.message);
        resolve({ ok: false, error: e.message });
      });
      req.write(payload);
      req.end();
    } catch (e) {
      console.error(`[dashboard] ${eventType} failed:`, e.message);
      resolve({ ok: false, error: e.message });
    }
  });
}

module.exports = { forwardToDashboard };
