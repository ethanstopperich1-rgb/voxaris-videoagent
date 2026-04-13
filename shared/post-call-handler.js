/**
 * Shared post-call webhook handler for Tavus system/application events.
 *
 * Handles events that fire AFTER a conversation ends:
 *   - system.shutdown          → dashboard "conversation_ended"
 *   - application.transcription_ready → dashboard "transcript_ready"
 *   - application.perception_analysis → dashboard "perception_ready"
 *   - application.recording_ready     → dashboard "recording_ready"
 *
 * Both /api/staffing/tools and /api/realty/tools delegate here for
 * post-call events. Data is forwarded to the Voxaris Dashboard webhook
 * at /api/webhooks/interview, which writes to the `interviews` table.
 */

const { forwardToDashboard } = require("./dashboard-webhook");
const { getSession } = require("./session-store");

/**
 * Main handler — returns true if this payload was a post-call event
 * (so the caller knows not to process it further), false otherwise.
 */
async function handlePostCallEvent(payload, vertical) {
  const eventType = payload.event_type || payload.type || "";
  const conversationId = payload.conversation_id || payload.conversationId || null;
  if (!conversationId) return false;

  const isPostCall =
    eventType === "system.shutdown" ||
    eventType === "system.replica_joined" ||
    eventType === "application.transcription_ready" ||
    eventType === "application.perception_analysis" ||
    eventType === "application.recording_ready";

  if (!isPostCall) return false;

  const props = payload.properties || {};

  try {
    switch (eventType) {
      case "system.replica_joined": {
        // Replica joined — conversation is live. No dashboard action needed.
        console.log(`[post-call] replica joined: ${conversationId}`);
        break;
      }

      case "system.shutdown": {
        // Fetch session to get final status
        const session = await getSession(conversationId).catch(() => null);
        const shutdownData = {
          status: session?.status || "ended",
          disqualified: session?.disqualified || false,
          disqualification_reason: session?.disqualification_reason || null,
          ended_at: new Date().toISOString(),
          completed_at: session?.completed_at || null,
          perception_signals: session?.perception_signals || [],
          shutdown_reason: props.shutdown_reason || null,
        };
        if (session?.status === "completed") {
          shutdownData.completed_at = session.completed_at || new Date().toISOString();
        }
        await forwardToDashboard("conversation_ended", conversationId, shutdownData);
        console.log(`[post-call] shutdown forwarded: ${conversationId} (${props.shutdown_reason || "unknown"})`);
        break;
      }

      case "application.transcription_ready": {
        const transcript = props.transcript || null;
        await forwardToDashboard("transcript_ready", conversationId, {
          transcript,
        });
        const turns = Array.isArray(transcript) ? transcript.length : 0;
        console.log(`[post-call] transcript forwarded: ${conversationId} (${turns} turns)`);
        break;
      }

      case "application.perception_analysis": {
        const analysis = props.analysis || null;
        // Parse structured perception if Raven-1 returns JSON
        let perceptionAnalysis = {};
        if (typeof analysis === "string") {
          try {
            perceptionAnalysis = JSON.parse(analysis);
          } catch {
            perceptionAnalysis = { summary: analysis };
          }
        } else if (analysis && typeof analysis === "object") {
          perceptionAnalysis = analysis;
        }
        await forwardToDashboard("perception_ready", conversationId, {
          perception_analysis: perceptionAnalysis,
        });
        console.log(`[post-call] perception forwarded: ${conversationId}`);
        break;
      }

      case "application.recording_ready": {
        const s3Key = props.s3_key || null;
        await forwardToDashboard("recording_ready", conversationId, {
          recording_s3_key: s3Key,
        });
        console.log(`[post-call] recording forwarded: ${conversationId} → ${s3Key}`);
        break;
      }
    }
  } catch (e) {
    console.error(`[post-call] ${eventType} handler failed for ${conversationId}:`, e.message);
  }

  return true;
}

module.exports = { handlePostCallEvent };
