# Google FX Flow Browser Automation API (Video & Image Generator)

Browser automation system for **Google FX Flow** (`https://labs.google/fx/tools/flow`) with native MongoDB persistence, in-memory background job queue, and REST status check endpoint.

---

## 🔐 One-Time Google Session Setup

Run the setup command to open Google FX Flow in Chrome, log into your Google account, and save your persistent session:

```bash
npm run setup
```
1. A Chrome browser window will open to `https://labs.google/fx/tools/flow`.
2. Click **Sign in with Google** and complete login.
3. Return to terminal and press **Enter** to save your session to `./browser-profile-google`.

---

## 🚀 Running the API Server

```bash
# Start development server with auto-reload
npm run dev

# Start production server
npm run start
```

Server runs on `http://localhost:5001`.

---

## 📡 API Endpoints

### 1. Submit Generation Request (Async Queue)
- **Endpoint**: `POST /api/fx-flow/generate` (or `POST /api/fx-flow`)
- **Body**:
  ```json
  {
    "type": "video", // "video" or "image"
    "prompt": "A futuristic electric supercar driving through a neon city at night",
    "settings": {
      "model": "omni-flash",
      "aspectRatio": "16:9",
      "duration": "5s"
    }
  }
  ```
- **Response (HTTP 202 Accepted)**:
  ```json
  {
    "success": true,
    "itemId": "gen_8f9a2b1c",
    "status": "pending",
    "type": "video",
    "prompt": "...",
    "settings": { ... },
    "message": "Generation job queued successfully. Check status at /api/fx-flow/status/gen_8f9a2b1c",
    "statusUrl": "/api/fx-flow/status/gen_8f9a2b1c"
  }
  ```

---

### 2. Check Job Status & Retrieve Result
- **Endpoint**: `GET /api/fx-flow/status/:itemId`
- **Response**:
  ```json
  {
    "success": true,
    "itemId": "gen_8f9a2b1c",
    "status": "completed", // "pending" | "processing" | "completed" | "failed"
    "type": "video",
    "prompt": "...",
    "settings": { ... },
    "result": {
      "videoUrl": "https://...",
      "imageUrl": null,
      "mediaUrls": ["https://..."],
      "text": "..."
    },
    "error": null,
    "durationMs": 18500,
    "createdAt": "2026-07-29T...",
    "updatedAt": "2026-07-29T..."
  }
  ```

---

### 3. List Recent Jobs
- **Endpoint**: `GET /api/fx-flow/jobs`

---

## 🗄️ Database Connection

Connected directly via native `mongodb` driver:
```env
MONGODB_URI=mongodb://dealvercel:juicehead2410@72.60.118.141:27017/dv-content-genrator?authSource=admin
```

Collection name: `generation_jobs`.
