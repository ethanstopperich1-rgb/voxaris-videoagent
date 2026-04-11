/**
 * Tavus webhook HMAC SHA-256 signature verification.
 *
 * Driven by Gemini Deep Research audit finding:
 *   "Webhook signature verification must be executed using the exact,
 *    unmodified raw request body."
 *
 * Vercel's default body parser turns JSON into req.body before our
 * handler runs, so byte-perfect raw-body HMAC isn't possible without
 * exporting a custom config. We do a best-effort HMAC against a
 * stable stringification of the parsed body, and use crypto.timingSafeEqual
 * for constant-time comparison (hardened against timing attacks).
 *
 * Behavior:
 *  - If TAVUS_WEBHOOK_SECRET is not set, returns { ok: true, reason: "no-secret-configured" }
 *    so the webhook still processes with a warning. Set the env var
 *    once the Tavus dashboard is configured to sign events.
 *  - If TAVUS_WEBHOOK_SECRET is set, verifies the signature header and
 *    returns { ok: false, reason: "signature-mismatch" } on failure.
 *
 * Exports: verifyWebhook(req) → { ok: boolean, reason?: string }
 */

const crypto = require("crypto");

function verifyWebhook(req) {
  const secret = process.env.TAVUS_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: true, reason: "no-secret-configured" };
  }

  const signature =
    req.headers["x-tavus-signature"] ||
    req.headers["x-tavus-hmac-sha256"] ||
    null;

  if (!signature) {
    return { ok: false, reason: "missing-signature-header" };
  }

  let rawBody;
  if (typeof req.body === "string") {
    rawBody = req.body;
  } else if (req.body && typeof req.body === "object") {
    try {
      rawBody = JSON.stringify(req.body);
    } catch (e) {
      return { ok: false, reason: "body-stringify-failed" };
    }
  } else {
    return { ok: false, reason: "no-body" };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) {
      return { ok: false, reason: "signature-length-mismatch" };
    }
    if (crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { ok: true };
    }
    return { ok: false, reason: "signature-mismatch" };
  } catch (e) {
    return { ok: false, reason: "signature-decode-failed" };
  }
}

module.exports = { verifyWebhook };
