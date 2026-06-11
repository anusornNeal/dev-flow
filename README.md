<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/fa2c1394-8daa-4368-b46b-523d22421e14

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Persistence & Concurrency

The DevFlow backend stores tasks and projects in `tasks.json` and `projects.json`. 

**Concurrent Updates & Safe Reloading:**
The backend reads the latest disk state synchronously immediately before any mutation to `tasks.json`. This "safe reload" ensures that if an agent manually modifies `tasks.json` on disk, the backend will merge those changes and will not overwrite them with a stale in-memory cache. 

However, to guarantee atomic updates and prevent race conditions when multiple agents are active, it is highly recommended to mutate tasks using the REST API or the provided MCP tools rather than modifying `tasks.json` directly.

## Local Storage
DevFlow uses a local SQLite database (data/devflow.db) to persist your tasks, projects, and settings. On the very first run, it will automatically migrate any existing .json persistence files into the database and back them up as .bak files. No manual database setup or external DB server is required.
