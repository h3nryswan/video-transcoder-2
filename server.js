import express from "express";
import fileUpload from "express-fileupload";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import os from "os";
import { nanoid } from "nanoid";
import { putBuffer, putFile, downloadToFile, presignGet } from "./lib/s3.js";
import {
  putFileMeta, listFilesByOwner, getFileMeta, setFileSize,
  putJob, getJob, updateJob,
  claimJob, heartbeatJob, requeueStaleJobs, listQueuedJobs, listJobsByOwner, setFileReady   // <-- ADD
} from "./lib/dynamo.js";
import { presignPut } from "./lib/s3.js"; // add this import
import { ResendConfirmationCodeCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand, RespondToAuthChallengeCommand, AuthFlowType } from "@aws-sdk/client-cognito-identity-provider";
import * as jose from "jose";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import crypto from "crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";



function secretHash(username) {
  const h = crypto.createHmac("sha256", process.env.COGNITO_CLIENT_SECRET);
  h.update(`${username}${process.env.COGNITO_CLIENT_ID}`);
  return h.digest("base64");
}

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-southeast-2";
const ssm = new SSMClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.COGNITO_REGION });
const secrets = new SecretsManagerClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3raw = new S3Client({ region: REGION });
const COG_REGION = process.env.COGNITO_REGION;
const COG_POOL   = process.env.COGNITO_USER_POOL_ID;
const COG_CLIENT = process.env.COGNITO_CLIENT_ID;
let YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3/search";
if (!COG_REGION || !COG_POOL || !COG_CLIENT) {
  console.warn("Missing Cognito env (COGNITO_REGION / COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID)");
}

async function loadYoutubeApiBase() {
  try {
    const resp = await ssm.send(new GetParameterCommand({
      Name: "/n11049481/YT_API_BASE",
      WithDecryption: false
    }));
    if (resp?.Parameter?.Value) {
      YOUTUBE_API_BASE = resp.Parameter.Value;
      console.log("[CFG] Loaded YT_API_BASE from SSM:", YOUTUBE_API_BASE);
    }
  } catch (err) {
    console.warn("[CFG] Could not load YT_API_BASE from SSM, falling back:", err?.name || err);
  }
}

async function loadSecrets() {
  const secretId = process.env.SECRETS_NAME || "/n11049481/app-secrets";
  try {
    const resp = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    let raw = resp.SecretString ?? Buffer.from(resp.SecretBinary || "", "base64").toString("utf8");
    let obj;
    try { obj = JSON.parse(raw); } catch { obj = { YT_API_KEY: raw }; }

    if (obj.YT_API_KEY)            process.env.YT_API_KEY = process.env.YT_API_KEY || obj.YT_API_KEY;
    YT_API_KEY = process.env.YT_API_KEY;
    if (obj.COGNITO_CLIENT_SECRET) process.env.COGNITO_CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET || obj.COGNITO_CLIENT_SECRET;

    console.log("[CFG] Secrets loaded from Secrets Manager");
  } catch (e) {
    console.warn("[CFG] Could not load secrets; falling back to env:", e?.name || e);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
let YT_API_KEY = process.env.YT_API_KEY || "";

// --- Demo users (hard-coded, per brief) ---
const USERS = [
  { id: "u1", username: "alice", password: "pass123", role: "admin" },
  { id: "u2", username: "bob",   password: "pass123", role: "user"  },
];

// --- Express app ---
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: 1024 * 1024 * 1024 } })); // up to 1GB demo
app.use(express.static(path.join(__dirname, "public")));

// // --- Auth middleware ---
// function auth(req, res, next) {
//   const h = req.headers.authorization || "";
//   let token = h.startsWith("Bearer ") ? h.slice(7) : null;

//   // allow token in querystring for direct <a> downloads
//   if (!token && req.query && typeof req.query.token === "string") {
//     token = req.query.token;
//   }

//   if (!token) return res.status(401).json({ error: "Missing token" });
//   try {
//     req.user = jwt.verify(token, JWT_SECRET);
//     next();
//   } catch {
//     return res.status(401).json({ error: "Invalid token" });
//   }
// }

// --- Cognito JWT verification (accepts ID or Access token) ---
const ISSUER   = `https://cognito-idp.${COG_REGION}.amazonaws.com/${COG_POOL}`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const jwks     = jose.createRemoteJWKSet(new URL(JWKS_URL));

async function verifyCognitoJwt(token) {
  // Verify signature + issuer, allow small clock skew so fresh tokens don't look expired
  const { payload } = await jose.jwtVerify(token, jwks, {
    issuer: ISSUER,
    clockTolerance: 60, // seconds
  });

  // Enforce correct audience/client depending on token_use
  const use = payload.token_use; // 'id' or 'access'
  if (use === 'id') {
    // ID tokens must have aud == app client id
    if (payload.aud !== COG_CLIENT) {
      throw new jose.errors.JWTClaimValidationFailed('aud mismatch', 'aud');
    }
  } else if (use === 'access') {
    // Access tokens carry client_id (not aud)
    if (payload.client_id !== COG_CLIENT) {
      throw new jose.errors.JWTClaimValidationFailed('client_id mismatch', 'client_id');
    }
  } else {
    throw new jose.errors.JWTClaimValidationFailed('unknown token_use', 'token_use');
  }

  return payload;
}

// Middleware: read Bearer header OR ?token=... (for /download links)
async function auth(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const qsTok  = req.query?.token;
    const token  = header.startsWith("Bearer ") ? header.slice(7) : qsTok;

    if (!token) return res.status(401).json({ error: "MissingToken", message: "No bearer token" });

    const payload = await verifyCognitoJwt(token);

    req.user = {
      sub: payload.sub,
      username: payload["cognito:username"] || payload.username || payload.email,
      email: payload.email,
      token_use: payload.token_use,
      exp: payload.exp,
      // carry groups through so downstream code can authorize
      ["cognito:groups"]: Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"] : [],
      groups: Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"] : [], // convenience alias
    };

    return next();
  } catch (e) {
    const name = e?.name || 'AuthError';
    const msg  = e?.message || 'Invalid token';
    const status = 401;
    return res.status(status).json({ error: name, message: msg });
  }
}


function getGroups(req) {
  const g = req.user?.["cognito:groups"] ?? req.user?.groups;
  return Array.isArray(g) ? g : [];
}

function requireAdmin(req, res, next) {
  if (!getGroups(req).includes("Admin")) {
    return res.status(403).json({ error: "Forbidden: Admins only" });
  }
  next();
}



// --- Routes ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// Login → returns JWT
// app.post("/login", (req, res) => {
//   const { username, password } = req.body || {};
//   const user = USERS.find((u) => u.username === username && u.password === password);
//   if (!user) return res.status(401).json({ error: "Invalid credentials" });
//   const token = jwt.sign(
//     { sub: user.id, username: user.username, role: user.role },
//     JWT_SECRET,
//     { expiresIn: "2h" }
//   );
//   res.status(200).json({ token });
// });

// POST /auth/register { username, email, password }
app.post("/auth/register", async (req, res) => {
  const { username, email, password } = req.body || {};
  try {
    const out = await cognito.send(new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      SecretHash: secretHash(username),
      Username: username,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
    }));
    res.json({ ok: true, userSub: out.UserSub });
  } catch (e) {
    res.status(400).json({ error: e.name, message: e.message });
  }
});

// POST /auth/confirm { username, code }
app.post("/auth/confirm", async (req, res) => {
  const { username, code } = req.body || {};
  try {
    await cognito.send(new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      SecretHash: secretHash(username),
      Username: username,
      ConfirmationCode: code,
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.name, message: e.message });
  }
});


// POST /auth/resend { username }
app.post("/auth/resend", async (req, res) => {
  const { username } = req.body || {};
  try {
    await cognito.send(new ResendConfirmationCodeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      SecretHash: secretHash(username),
      Username: username,
    }));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.name, message: e.message });
  }
});




// POST /auth/login { username, password }
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "BadRequest", message: "username/password required" });

  try {
    const out = await cognito.send(new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: secretHash(username),
      },
    }));

    // If Cognito requires an extra step (like EMAIL_OTP), return that info to the client.
    if (out.ChallengeName) {
      return res.status(200).json({
        challenge: out.ChallengeName,     // e.g. "EMAIL_OTP"
        session: out.Session,             // must be echoed back in the next call
        username                          // convenience for the client
      });
    }

    const a = out.AuthenticationResult;
    if (!a?.IdToken) return res.status(401).json({ error: "AuthFailed", message: "No tokens returned" });

    return res.json({
      idToken: a.IdToken,
      accessToken: a.AccessToken,
      refreshToken: a.RefreshToken,
      expiresIn: a.ExpiresIn,
      tokenType: a.TokenType,
    });

  } catch (e) {
    if (e.name === "UserNotConfirmedException") {
      return res.status(403).json({ error: e.name, message: "Account not confirmed.", needsConfirmation: true });
    }
    return res.status(401).json({ error: e.name || "AuthFailed", message: e.message });
  }
});

// POST /auth/login/otp { username, code, session }
app.post("/auth/login/otp", async (req, res) => {
  const { username, code, session } = req.body || {};
  if (!username || !code || !session) {
    return res.status(400).json({ error: "BadRequest", message: "username, code, session required" });
  }

  try {
    const out = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      ChallengeName: "EMAIL_OTP",
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        SECRET_HASH: secretHash(username),
        EMAIL_OTP_CODE: code,           // <-- the field Cognito expects
      },
    }));

    const a = out.AuthenticationResult;
    if (!a?.IdToken) {
      return res.status(401).json({ error: "AuthFailed", message: "OTP accepted but no tokens returned" });
    }

    return res.json({
      idToken: a.IdToken,
      accessToken: a.AccessToken,
      refreshToken: a.RefreshToken,
      expiresIn: a.ExpiresIn,
      tokenType: a.TokenType,
    });

  } catch (e) {
    return res.status(401).json({ error: e.name || "AuthFailed", message: e.message });
  }
});


// Upload: bytes to S3 + metadata to Dynamo
app.post("/upload", auth, async (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ error: "No file uploaded" });
  const f = Array.isArray(req.files.file) ? req.files.file[0] : req.files.file;

  const id = nanoid();
  const safeName = (f.name || "video").replace(/[^a-zA-Z0-9._-]/g, "_");
  const createdAt = Date.now();
  const s3Key = `${req.user.sub}/original/${id}_${safeName}`;

  try {
    await putBuffer(s3Key, f.data, f.mimetype);
    await putFileMeta({
      id, owner: req.user.sub, kind: "original", name: safeName,
      s3Key, size: f.size, mimetype: f.mimetype, createdAt
    });
    res.status(201).json({ fileId: id });
  } catch (e) {
    res.status(500).json({ error: "Upload failed: " + e.message });
  }
});


// List current user's latest 5 files (from Dynamo GSI)
// app.get("/files", auth, async (req, res) => {
//   try {
//     const mine = await listFilesByOwner(req.user.sub, 5);
//     res.json({ files: mine });
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

app.get("/files", auth, async (req, res) => {
  try {
    if (getGroups(req).includes("Admin") && String(req.query.all) === "1") {
      if (!process.env.DDB_TABLE_FILES) {
        return res.status(500).json({ error: "ServerMisconfig", message: "DDB_TABLE_FILES not set" });
      }
      const out = await ddb.send(new ScanCommand({
        TableName: process.env.DDB_TABLE_FILES,
        ProjectionExpression: "#id, #owner, kind, #name, s3Key, size, mimetype, createdAt, ready",
        ExpressionAttributeNames: {
          "#name": "name",
          "#id": "id",
          "#owner": "owner"
        },
        // optionally: Limit: 200
      }));

      const all = (out.Items || []).sort((a,b) => (b.createdAt||0) - (a.createdAt||0));
      return res.json({ files: all });
    }

    const mine = await listFilesByOwner(req.user.sub, 5);
    return res.json({ files: mine });
  } catch (e) {
    console.error("Admin /files?all=1 failed:", e);  // <- check CloudWatch logs too
    return res.status(500).json({ error: e.name || "Error", message: e.message });
  }
});


// --- Admin: delete any file (metadata + S3 object) ---
app.delete("/admin/files/:owner/:id", auth, requireAdmin, async (req, res) => {
  const { owner, id } = req.params;
  try {
    const meta = await getFileMeta(owner, id);
    if (!meta) return res.status(404).json({ error: "File not found" });

    // 1) delete Dynamo item
    await ddb.send(new DeleteCommand({
      TableName: process.env.DDB_TABLE_FILES,
      Key: { owner, id }
    }));

    // 2) delete S3 object (ignore if missing)
    if (meta.s3Key) {
      await s3raw.send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: meta.s3Key
      }));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// server.js
// server.js (existing, keep this)
app.get("/download/:id", auth, async (req, res) => {
  const meta = await getFileMeta(req.user.sub, req.params.id);   // ✅ Dynamo, not db
  if (!meta) return res.status(404).json({ error: "File not found" });

  const ready = meta.ready === true || (meta.kind === "transcoded" && (meta.size|0) > 0);
  if (meta.kind === "transcoded" && !ready) {
    return res.status(409).json({ error: "NotReady", message: "Transcode not finished yet." });
  }

  try {
    const url = await presignGet(meta.s3Key, 200);
    return res.redirect(url);                                    // keep redirect (no CORS woes)
  } catch (e) {
    return res.status(404).json({ error: "Object missing in S3 for " + meta.s3Key });
  }
});






// Queue a transcode job
app.post("/transcode/:id", auth, async (req, res) => {
  const input = await getFileMeta(req.user.sub, req.params.id);
  if (!input || input.kind !== "original") {
    return res.status(404).json({ error: "Original video not found" });
  }

  const outId   = nanoid();
  const jobId   = nanoid();
  const outName = input.name.replace(/\.[^.]+$/, "") + "_transcoded.mp4";
  const outKey  = `${req.user.sub}/transcoded/${outId}_${outName}`;
  const now     = Date.now();

  await putFileMeta({
    id: outId, owner: req.user.sub, kind: "transcoded", name: outName,
    s3Key: outKey, size: 0, mimetype: "video/mp4", createdAt: now, inputId: input.id, ready: false
  });

  await putJob({
    id: jobId, owner: req.user.sub, inputId: input.id, outputId: outId,
    status: "queued", startedAt: null, finishedAt: null, error: null,
  });

  // setImmediate(() => runTranscodeJob(req.user.sub, jobId));
  res.status(202).json({ jobId, outputFileId: outId });
});

app.get("/jobs/active", auth, async (req, res) => {
  try {
    const jobs = await listJobsByOwner(req.user.sub, 20, true);
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// Poll job status
app.get("/jobs/:id", auth, async (req, res) => {
  const j = await getJob(req.user.sub, req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found" });
  res.json(j);
});


// YouTube related videos for a file (by filename from Dynamo)
app.get("/related/:id", auth, async (req, res) => {
  try {
    const file = await getFileMeta(req.user.sub, req.params.id);
    if (!file) return res.status(404).json({ error: "File not found" });
    if (!YT_API_KEY) return res.status(500).json({ error: "YT_API_KEY not set" });

    const base = (file.name || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim() || "video";

    const url = new URL(YOUTUBE_API_BASE);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "8");
    url.searchParams.set("q", base);
    url.searchParams.set("key", YT_API_KEY);

    const resp = await fetch(url);
    if (!resp.ok) return res.status(502).json({ error: `YouTube API ${resp.status}` });

    const data = await resp.json();
    const items = (data.items || [])
      .map(it => ({
        title: it.snippet?.title,
        channel: it.snippet?.channelTitle,
        thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url,
        url: it.id?.videoId ? `https://www.youtube.com/watch?v=${it.id.videoId}` : null,
      }))
      .filter(x => x.url);

    res.json({ query: base, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Step 1: client asks for a pre-signed PUT
app.post("/upload/init", auth, async (req, res) => {
  const { filename, contentType } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "BadRequest" });

  const id        = nanoid();
  const safeName  = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const createdAt = Date.now();
  const s3Key     = `${req.user.sub}/original/${id}_${safeName}`;

  // short-lived URL to PUT directly to S3
  const url = await presignPut(s3Key, contentType, 300);

  // return the info the client needs; we’ll write Dynamo after S3 succeeds
  res.json({ fileId: id, s3Key, url, createdAt });
});

// Step 2: after the PUT succeeds, client calls complete to write metadata
app.post("/upload/complete", auth, async (req, res) => {
  const { fileId, s3Key, name, size, mimetype, createdAt } = req.body || {};
  if (!fileId || !s3Key || !name || !size || !mimetype) {
    return res.status(400).json({ error: "BadRequest" });
  }
  await putFileMeta({
    id: fileId, owner: req.user.sub, kind: "original", name,
    s3Key, size, mimetype, createdAt: createdAt || Date.now()
  }); // writes to DynamoDB (same as your current /upload does) :contentReference[oaicite:6]{index=6}
  res.status(201).json({ fileId });
});

async function runTranscodeJob(owner, jobId, workerId = `${os.hostname()}-${process.pid}`) {
  const job = await getJob(owner, jobId);
  if (!job) return;

  await updateJob(owner, jobId, { status: "running", startedAt: Date.now(), workerId });

  const hb = setInterval(() => heartbeatJob(jobId, owner, workerId).catch(()=>{}), 10 * 1000);

  const input  = await getFileMeta(owner, job.inputId);
  const output = await getFileMeta(owner, job.outputId);

  if (!input?.s3Key) {
    clearInterval(hb);
    await updateJob(owner, jobId, { status: "error", finishedAt: Date.now(), error: "Input S3 key not found" });
    return;
  }
  if (!output?.s3Key) {
    clearInterval(hb);
    await updateJob(owner, jobId, { status: "error", finishedAt: Date.now(), error: "Output placeholder not found" });
    return;
  }

  const ext    = path.extname(input.name || ".mp4") || ".mp4";
  const tmpIn  = path.join(os.tmpdir(), `${jobId}-in${ext}`);
  const tmpOut = path.join(os.tmpdir(), `${jobId}-out.mp4`);

  try {
    await downloadToFile(input.s3Key, tmpIn);
    const args = ["-y","-hide_banner","-loglevel","error","-i", tmpIn, "-c:v","libx264","-preset","veryslow","-crf","23","-c:a","aac","-b:a","128k","-movflags","+faststart", tmpOut];
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });

    await putFile(output.s3Key, tmpOut, "video/mp4");
    try {
      const st = fs.statSync(tmpOut);
      await setFileSize(owner, output.id, st.size);
    } catch {}

    await setFileReady(owner, output.id, true);

    clearInterval(hb);
    await updateJob(owner, jobId, { status: "done", finishedAt: Date.now() });
  } catch (err) {
    clearInterval(hb);
    await updateJob(owner, jobId, { status: "error", finishedAt: Date.now(), error: err?.message || String(err) });
  } finally {
    try { fs.existsSync(tmpIn)  && fs.unlinkSync(tmpIn); }  catch {}
    try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch {}
  }
}


// ===== Stateless worker loop =====
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// periodically requeue stale jobs (worker crashed, etc.)
setInterval(() => {
  requeueStaleJobs(20 * 1000).catch(() => {});
}, 5 * 1000);

// before the try in workerLoop:
console.log("[WORKER]", WORKER_ID, "loop tick");

async function workerLoop() {
  try {
    const queued = await listQueuedJobs(3);
    // console.log("[WORKER]", WORKER_ID, "found", queued.length, "queued");
    for (const j of queued) {
      try {
        await claimJob(j.id, j.owner, WORKER_ID);
      } catch (e) {
        console.warn("[WORKER] claim failed", {
          jobId: j.id, owner: j.owner,
          err: e?.name || e?.code || e, msg: e?.message
        });
        continue;
      }
      console.log("[WORKER]", WORKER_ID, "claimed", j.id);
      await runTranscodeJob(j.owner, j.id, WORKER_ID);
    }
  } catch (e) {
    console.warn("worker error", e);
  } finally {
    setTimeout(workerLoop, 1500);
  }
}

workerLoop();

(async () => {
  await loadYoutubeApiBase();
  await loadSecrets();

  app.listen(PORT, () => {
    console.log(`API listening on http://0.0.0.0:${PORT}`);
  });
})();
