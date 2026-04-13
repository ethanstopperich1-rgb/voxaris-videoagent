#!/usr/bin/env node
/**
 * Patch Jordan v2.0 + Buyback/Maria v4.0 to live Tavus personas.
 *
 * Uses JSON Patch (RFC 6902) via PATCH /v2/personas/{persona_id}.
 * Reads the canonical persona JSON files from /personas/ and
 * /site/api/voxaris/tavus/ respectively.
 *
 * Usage: node scripts/patch-personas-v2.js [--jordan] [--buyback] [--dry-run]
 *        No flags = patch both.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");

const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
if (!TAVUS_API_KEY) {
  console.error("TAVUS_API_KEY not set");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const doJordan = args.length === 0 || args.includes("--jordan");
const doBuyback = args.length === 0 || args.includes("--buyback");

function loadJson(filePath) {
  const abs = path.resolve(__dirname, "..", filePath);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

function tavusPatch(personaId, operations) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(operations);
    const options = {
      hostname: "tavusapi.com",
      path: `/v2/personas/${personaId}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TAVUS_API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data || "OK" });
        } else if (res.statusCode === 304) {
          resolve({ status: 304, body: "Not Modified" });
        } else {
          reject(
            new Error(
              `Tavus PATCH ${personaId} returned ${res.statusCode}: ${data}`
            )
          );
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Tavus persona PATCH only accepts persona-level fields.
// objectives, guardrails, tools, and properties are conversation-level
// params passed via POST /v2/conversations, not PATCH /v2/personas.
const PERSONA_PATCHABLE_FIELDS = [
  "system_prompt",
  "persona_name",
  "layers",
  "greeting",
  "pipeline_mode",
  "default_replica_id",
];

function buildPatchOps(persona) {
  const ops = [];

  for (const field of PERSONA_PATCHABLE_FIELDS) {
    if (persona[field] !== undefined) {
      // Deep-clone layers so we can fix Claude-specific constraints
      let value = persona[field];
      if (field === "layers" && value.llm) {
        value = JSON.parse(JSON.stringify(value));
        // Claude models reject temperature + top_p together
        if (
          value.llm.model &&
          value.llm.model.includes("claude") &&
          value.llm.extra_body
        ) {
          if (
            value.llm.extra_body.temperature !== undefined &&
            value.llm.extra_body.top_p !== undefined
          ) {
            delete value.llm.extra_body.top_p;
          }
        }
      }
      ops.push({
        op: "add",
        path: `/${field}`,
        value,
      });
    }
  }

  return ops;
}

async function main() {
  const results = [];

  if (doJordan) {
    console.log("Loading Jordan v2.0...");
    const jordan = loadJson("personas/jordan.json");
    const ops = buildPatchOps(jordan);
    console.log(`  ${ops.length} patch operations for ${jordan.persona_id}`);

    if (dryRun) {
      console.log("  [DRY RUN] Would patch:", ops.map((o) => o.path).join(", "));
    } else {
      try {
        const res = await tavusPatch(jordan.persona_id, ops);
        console.log(`  Jordan patched: ${res.status}`);
        results.push({ persona: "jordan", status: res.status });
      } catch (e) {
        console.error(`  Jordan FAILED:`, e.message);
        results.push({ persona: "jordan", status: "error", error: e.message });
      }
    }
  }

  if (doBuyback) {
    console.log("Loading Buyback/Maria v4.0...");
    // Buyback config lives in the voxaris site repo
    const buybackPath = path.resolve(
      __dirname,
      "../../voxaris/site/api/voxaris/tavus/buyback-persona-config.json"
    );
    let buyback;
    try {
      buyback = JSON.parse(fs.readFileSync(buybackPath, "utf8"));
    } catch {
      // Fallback: try relative to videoagent root
      buyback = loadJson(
        "../voxaris/site/api/voxaris/tavus/buyback-persona-config.json"
      );
    }
    const ops = buildPatchOps(buyback);
    console.log(`  ${ops.length} patch operations for ${buyback.persona_id}`);

    if (dryRun) {
      console.log("  [DRY RUN] Would patch:", ops.map((o) => o.path).join(", "));
    } else {
      try {
        const res = await tavusPatch(buyback.persona_id, ops);
        console.log(`  Buyback patched: ${res.status}`);
        results.push({ persona: "buyback", status: res.status });
      } catch (e) {
        console.error(`  Buyback FAILED:`, e.message);
        results.push({
          persona: "buyback",
          status: "error",
          error: e.message,
        });
      }
    }
  }

  if (!dryRun) {
    console.log("\nResults:", JSON.stringify(results, null, 2));
  }
}

main();
