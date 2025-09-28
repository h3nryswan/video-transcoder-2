// lib/params.js
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-southeast-2";
const ssm = new SSMClient({ region: REGION });

/**
 * names: map of logical keys -> SSM parameter names
 * returns: object with resolved values (uses env fallback)
 */
export async function loadParams(names, { decrypt = true } = {}) {
  const entries = Object.entries(names);
  const paramNames = entries.map(([, p]) => p);
  const out = { };

  // start with env fallbacks
  for (const [key] of entries) out[key] = process.env[key];

  if (paramNames.length === 0) return out;

  const resp = await ssm.send(new GetParametersCommand({
    Names: paramNames,
    WithDecryption: decrypt
  }));

  // map found parameters back to our keys
  const byName = new Map((resp.Parameters || []).map(p => [p.Name, p.Value]));
  for (const [key, pName] of entries) {
    const val = byName.get(pName);
    if (val != null && val !== "") out[key] = val;
  }

  // optionally warn about any missing ones (not critical)
  const invalid = (resp.InvalidParameters || []);
  if (invalid.length) {
    console.warn("Missing SSM params:", invalid.join(", "));
  }

  return out;
}
