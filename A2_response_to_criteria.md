Assignment 2 - Cloud Services Exercises - Response to Criteria
================================================

Instructions
------------------------------------------------
- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections.  If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed


Overview
------------------------------------------------

- **Name:** Henry Swan
- **Student number:** n11049481
- **Partner name (if applicable):** N/A
- **Application name:** Video Transcoder App
- **Two line description:** A web app for uploading videos, doing a simple transcode job and downloading ouputs. 
- **EC2 instance name or ID:** i-07cae16bd920e452c

------------------------------------------------

### Core - First data persistence service

- **AWS service name:**  S3
- **What data is being stored?:** Original and transcoded video files
- **Why is this service suited to this data?:** S3 is durable, inexpensive object storage designed for large blobs and supports browser-based uploads via pre-signed URLs.
- **Why is are the other services used not suitable for this data?:** Other services are not suitable for large binary files, they are optimised for key/value etc.
- **Bucket/instance/table name:** a2-n11049481-bucket 
- **Video timestamp:** 0:00
- **Relevant files:**
    -server.js (routes /upload/init, /upload/complete, /download/:id)
    -lib/s3.js
    -index.html

### Core - Second data persistence service

- **AWS service name:**  DynamoDB
- **What data is being stored?:** Video file metadata (id, name, owner, createdAt, kind=original|transcoded, size, ready) and transcode job records (id, inputId, outputId, status).
- **Why is this service suited to this data?:** Fast key/value access with flexible schema fits simple metadata and job states; low-latency reads to update the UI
- **Why is are the other services used not suitable for this data?:** Other services are inefficient for quering
- **Bucket/instance/table name:** a2-n11049481-files, a2-n11049481-jobs
- **Video timestamp:** 1:00
- **Relevant files:**
    -server.js (routes /files, /jobs , /transcode/:fileId)
    -dynamo.js

### Third data service

- **AWS service name:**  
- **What data is being stored?:** 
- **Why is this service suited to this data?:** 
- **Why is are the other services used not suitable for this data?:** 
- **Bucket/instance/table name:**
- **Video timestamp:**
- **Relevant files:**
    -

### S3 Pre-signed URLs

- **S3 Bucket names:** a2-n11049481-bucket
- **Video timestamp:** 2:01
- **Relevant files:**
    -server.js
    -index.html

### In-memory cache

- **ElastiCache instance name:**
- **What data is being cached?:** [eg. Thumbnails from YouTube videos obatined from external API]
- **Why is this data likely to be accessed frequently?:** [ eg. Thumbnails from popular YouTube videos are likely to be shown to multiple users ]
- **Video timestamp:**
- **Relevant files:**
    -

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** Short-lived temp files during transcode in the container’s /tmp (e.g., tmpIn, tmpOut). In-memory variables/timers for the worker loop and heartbeats (e.g., WORKER_ID, setInterval, setTimeout). In-flight upload bytes (only while streaming to S3 when using the legacy /upload path or the browser’s RAM during direct S3 PUT). (Client side) the browser keeps the ID token in localStorage—not server state.
- **Why is this data not considered persistent state?:** Temp transcode files are created from S3 input and deleted in finally, so they’re reproducible and disposable. Upload buffers are transient I/O; the durable artifacts are the objects in S3 and the metadata/job records in DynamoDB. Worker IDs, timers, and in-memory variables are ephemeral process memory; job ownership/heartbeat lives in DynamoDB and can be re-established by any fresh container.
- **How does your application ensure data consistency if the app suddenly stops?:** All persistent state is externalized: files in S3; file metadata and job state in DynamoDB. The API always reads/writes these stores (e.g., putFileMeta, getFileMeta, putJob, updateJob). Uploads use a two-step “presign → PUT to S3 → /upload/complete write to Dynamo” so metadata is only recorded after bytes land in S3. Transcoding writes a placeholder output record first, then runs ffmpeg, uploads the result to S3, updates size, and finally flips a ready flag. If the process dies at any step, records in Dynamo/S3 reflect the last safe point; no in-process cache is required. Jobs are claimed atomically (claimJob with conditional updates) and emit heartbeats; a background scan requeues stale jobs with missing/old heartbeats so another container can resume work. A periodic worker loop only pulls from the queued set in DynamoDB; on restart, it just continues from DynamoDB’s truth. Client behavior is resilient: the UI polls job status via HTTP; no websockets are required. A browser refresh or temporary network loss simply resumes polling against the persisted job state. Downloads use pre-signed S3 GET URLs, so no long-lived server connections are required. Consistency guards at read time: the /download/:id route refuses non-ready transcoded files (checks ready/size) to avoid serving half-written outputs
- **Relevant files:**
    -server.js - API routes, worker loop, transcode pipeline, temp-file lifecycle, presign flows, download readiness checks.
    -lib/dynamo.js - all persistent metadata & job operations, including claim/heartbeat/requeue logic and the ready flag
    -lib/s3.js - S3 interactions for PUT/GET, presigned URLs, and download to temp for ffmpeg.
    -index.html - purely client-side; token kept in localStorage, polling for jobs, direct S3 PUT via presign, and stateless download links. 

### Graceful handling of persistent connections

- **Type of persistent connection and use:** 
- **Method for handling lost connections:** 
- **Relevant files:**
    -


### Core - Authentication with Cognito

- **User pool name:** User pool - mgxcqj
- **How are authentication tokens handled by the client?:** The app stores the Cognito ID token in localStorage and sends it in the Authorization: Bearer <token> header on API requests.
- **Video timestamp:** 2:26
- **Relevant files:**
    -index.html (login/register UI, localStorage token handling) 
    -server.js (JWT verification against Cognito JWKS; protects routes)

### Cognito multi-factor authentication

- **What factors are used for authentication:** Password + email OPT challenge
- **Video timestamp:** 3:22
- **Relevant files:**
    -index.html (OTP UI: /auth/login/otp)
    -server.js (handles cognito challenge session continuation)

### Cognito federated identities

- **Identity providers used:** Google
- **Video timestamp:** 3:40
- **Relevant files:**
    -index.html
    -server.js

### Cognito groups

- **How are groups used to set permissions?:** Users in Admin group can see a Delete button and delete any user’s files via admin endpoint; non-admins do not see Delete and cannot call the endpoint.
- **Video timestamp:** 4:19
- **Relevant files:**
    -index.html
    -server.js (admin-only route: DELETE /admin/files/:owner/:id)

### Core - DNS with Route53

- **Subdomain**:  a2-n11049481.cab432.com
- **Video timestamp:** 4:52

### Parameter store

- **Parameter names:** /n11049481/YT_API_BASE
- **Video timestamp:** 4:57
- **Relevant files:** 
    -server.js (loads Parameter Store at startup; log line: “Loaded YT_API_BASE from SSM”)

### Secrets manager

- **Secrets names:** /n11049481/app-secrets - YT_API_KEY , COGNITO_CLIENT_SECRET
- **Video timestamp:** 5:03
- **Relevant files:**
    -server.js

### Infrastructure as code

- **Technology used:**
- **Services deployed:**
- **Video timestamp:**
- **Relevant files:**
    -

### Other (with prior approval only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**
    -

### Other (with prior permission only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**