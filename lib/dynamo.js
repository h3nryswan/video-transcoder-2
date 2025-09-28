// lib/dynamo.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand, GetCommand, QueryCommand, UpdateCommand, ScanCommand
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-southeast-2";
const TABLE_FILES = process.env.DDB_TABLE_FILES;
const TABLE_JOBS  = process.env.DDB_TABLE_JOBS;

if (!TABLE_FILES || !TABLE_JOBS) {
  console.warn("Dynamo tables not set. Set DDB_TABLE_FILES and DDB_TABLE_JOBS.");
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ----- Files -----
export async function putFileMeta(item) {
  await doc.send(new PutCommand({ TableName: TABLE_FILES, Item: item }));
  return item;
}

export async function getFileMeta(owner, id) {
  const r = await doc.send(new GetCommand({ TableName: TABLE_FILES, Key: { owner, id } }));
  return r.Item || null;
}

export async function listFilesByOwner(owner, limit = 5) {
  // Uses GSI_RecentByOwner to get newest first
  const r = await doc.send(new QueryCommand({
    TableName: TABLE_FILES,
    IndexName: "GSI_RecentByOwner",
    KeyConditionExpression: "#o = :o",
    ExpressionAttributeNames: { "#o": "owner" },
    ExpressionAttributeValues: { ":o": owner },
    ScanIndexForward: false, // DESC by createdAt
    Limit: limit
  }));
  return r.Items || [];
}

export async function setFileSize(owner, id, size) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_FILES,
    Key: { owner, id },
    UpdateExpression: "SET #s = :s",
    ExpressionAttributeNames: { "#s": "size" },
    ExpressionAttributeValues: { ":s": size }
  }));
}

// ----- Jobs -----
export async function putJob(job) {
  await doc.send(new PutCommand({ TableName: TABLE_JOBS, Item: job }));
  return job;
}

export async function getJob(owner, id) {
  const r = await doc.send(new GetCommand({ TableName: TABLE_JOBS, Key: { owner, id } }));
  return r.Item || null;
}

export async function updateJob(owner, id, updates) {
  // Minimal updater for status/timestamps/error
  const expr = [];
  const names = {};
  const values = {};
  for (const [k, v] of Object.entries(updates)) {
    const nk = `#${k}`, vk = `:${k}`;
    expr.push(`${nk} = ${vk}`);
    names[nk] = k;
    values[vk] = v;
  }
  await doc.send(new UpdateCommand({
    TableName: TABLE_JOBS,
    Key: { owner, id },
    UpdateExpression: `SET ${expr.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}

// Atomically claim a queued job
export async function claimJob(jobId, owner, workerId, now = Date.now()) {
  const cmd = new UpdateCommand({
    TableName: TABLE_JOBS,
    Key: { owner, id: jobId },
    UpdateExpression: "SET #s = :running, workerId = :w, startedAt = if_not_exists(startedAt, :now), heartbeatAt = :now",
    ConditionExpression: "#s = :queued OR (#s = :running AND attribute_not_exists(workerId))",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":queued": "queued",
      ":running": "running",
      ":w": workerId,
      ":now": now,
    },
    ReturnValues: "ALL_NEW",
  });
  return doc.send(cmd);
}

// Heartbeat from the worker that owns this job
export async function heartbeatJob(jobId, owner, workerId, now = Date.now()) {
  const cmd = new UpdateCommand({
    TableName: TABLE_JOBS,
    Key: { owner, id: jobId },
    UpdateExpression: "SET heartbeatAt = :now",
    ConditionExpression: "workerId = :w AND #s = :running",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":now": now, ":w": workerId, ":running": "running" },
  });
  return doc.send(cmd);
}

// Requeue jobs whose worker died (no heartbeat for > timeoutMs)
export async function requeueStaleJobs(timeoutMs = 5 * 60 * 1000) {
  const cutoff = Date.now() - timeoutMs;
  const scan = new ScanCommand({
    TableName: TABLE_JOBS,
    FilterExpression: "#s = :running AND (attribute_not_exists(heartbeatAt) OR heartbeatAt < :cutoff)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":running": "running", ":cutoff": cutoff },
  });
  const out = await doc.send(scan);
  const stale = out.Items || [];
  for (const j of stale) {
    try {
      await doc.send(new UpdateCommand({
        TableName: TABLE_JOBS,
        Key: { owner: j.owner, id: j.id },
        UpdateExpression: "REMOVE workerId SET #s = :queued",
        ConditionExpression: "#s = :running AND (attribute_not_exists(heartbeatAt) OR heartbeatAt < :cutoff)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":queued": "queued", ":running": "running", ":cutoff": cutoff },
      }));
    } catch {
      // someone else won the race; ignore
    }
  }
  return stale.length;
}

// Minimal queued list (small-scale scan; fine for the assignment)
// dynamo.js
export async function listQueuedJobs(limit = 10) {
  const items = [];
  let startKey = undefined;

  while (items.length < limit) {
    const out = await doc.send(new ScanCommand({
      TableName: TABLE_JOBS,
      FilterExpression: "#s = :queued",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":queued": "queued" },
      ExclusiveStartKey: startKey,  // paginate through the table
    }));
    items.push(...(out.Items || []));
    if (!out.LastEvaluatedKey) break;
    startKey = out.LastEvaluatedKey;
  }

  return items.slice(0, limit);
}


// dynamo.js
export async function listJobsByOwner(owner, limit = 20, onlyActive = false) {
  let items = [];
  try {
    const q = await doc.send(new QueryCommand({
      TableName: TABLE_JOBS,
      KeyConditionExpression: "#o = :o",
      ExpressionAttributeNames: { "#o": "owner" },
      ExpressionAttributeValues: { ":o": owner },
      ScanIndexForward: false,
      Limit: limit
    }));
    items = q.Items || [];
  } catch (e) {
    if (e.name !== "ValidationException") throw e;
    const s = await doc.send(new ScanCommand({
      TableName: TABLE_JOBS,
      FilterExpression: "#o = :o",
      ExpressionAttributeNames: { "#o": "owner" },
      ExpressionAttributeValues: { ":o": owner },
      Limit: limit
    }));
    items = s.Items || [];
  }

  if (onlyActive) {
    items = items.filter(j => j.status === "queued" || j.status === "running");
  }
  return items;
}


// add near other file helpers
export async function setFileReady(owner, id, ready) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_FILES,
    Key: { owner, id },
    UpdateExpression: "SET ready = :r",
    ExpressionAttributeValues: { ":r": !!ready }
  }));
}
