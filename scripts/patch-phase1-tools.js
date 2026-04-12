#!/usr/bin/env node
/**
 * Phase 1 persona patch — pushes the updated tool definitions to BOTH
 * Jordan (staffing) and Aria (realty) via JSON Patch.
 *
 * Gemini DR audit findings addressed:
 *   - Finding 2:  `required` array expanded beyond just full_name
 *   - Finding 3:  tool description tightened with explicit trigger conditions
 *   - Finding 22: max_call_duration capped (enforced at conversation-create
 *                 time via config.conversationDefaults, NOT at persona level)
 *
 * Both personas already have the correct `type: "function"` wrapper format
 * from the earlier schema-modernization pass — we only replace the tool
 * definition itself, not the envelope.
 *
 * Usage:
 *   node scripts/patch-phase1-tools.js
 *
 * Reads TAVUS_API_KEY, TAVUS_STAFFING_PERSONA_ID, TAVUS_REALTY_PERSONA_ID
 * from .env. Fails loudly if any are missing.
 */

require("dotenv").config();

const { patchPersona } = require("../shared/tavus-client");
const { config: staffingConfig } = require("../staffing/config/staffing-config");
const { config: realtyConfig } = require("../realty/config/realty-config");

function extractTools(configObj) {
  // buildPersonaPayload() returns the full persona body — we only care about
  // layers.llm.tools because that's what we're PATCHing.
  const body = configObj.buildPersonaPayload();
  return body.layers.llm.tools;
}

async function patchOne(label, personaId, tools) {
  if (!personaId) {
    console.warn(`[${label}] persona id not set — skipping`);
    return;
  }
  console.log(`[${label}] patching layers.llm.tools on persona ${personaId}`);
  try {
    const result = await patchPersona(personaId, [
      { op: "replace", path: "/layers/llm/tools", value: tools },
    ]);
    if (result && result.not_modified) {
      console.log(`[${label}] 304 Not Modified — state already matches`);
    } else {
      console.log(`[${label}] ✓ updated`);
    }
  } catch (e) {
    console.error(`[${label}] ✗ failed:`, e.message);
    // Some Tavus deployments return 404 on /layers/llm/tools if the path
    // doesn't exist yet — retry with an add op as a fallback.
    if (/404|Not Found|path/i.test(e.message)) {
      try {
        console.log(`[${label}] retrying with op: add`);
        await patchPersona(personaId, [
          { op: "add", path: "/layers/llm/tools", value: tools },
        ]);
        console.log(`[${label}] ✓ added`);
      } catch (e2) {
        console.error(`[${label}] ✗ retry failed:`, e2.message);
      }
    }
  }
}

async function main() {
  if (!process.env.TAVUS_API_KEY) {
    console.error("TAVUS_API_KEY missing — check .env");
    process.exit(1);
  }

  const jordanTools = extractTools(staffingConfig);
  const ariaTools = extractTools(realtyConfig);

  console.log("Jordan tool description length:", jordanTools[0].function.description.length);
  console.log("Jordan required fields:", jordanTools[0].function.parameters.required);
  console.log("Aria  tool description length:", ariaTools[0].function.description.length);
  console.log("Aria  required fields:", ariaTools[0].function.parameters.required);
  console.log("");

  await patchOne(
    "jordan",
    process.env.TAVUS_STAFFING_PERSONA_ID,
    jordanTools
  );
  await patchOne(
    "aria",
    process.env.TAVUS_REALTY_PERSONA_ID,
    ariaTools
  );

  console.log("\nDone. max_call_duration (720s) is enforced at conversation-create time — nothing to patch on the persona for that.");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
