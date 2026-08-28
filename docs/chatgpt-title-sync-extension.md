# DevFlow ChatGPT Title Sync Chrome Extension

## Purpose

`extensions/chatgpt-title-sync` is a small Manifest V3 extension that changes only the visible ChatGPT sidebar title for conversations that have already been associated with a DevFlow execution session.

The visible ChatGPT title is presentation metadata only. DevFlow never uses it as task identity, claim ownership, execution identity, or recovery identity. Duplicate visible titles are therefore safe.

## Supported surface

The first supported browser surface is ChatGPT web on:

- `https://chatgpt.com/*`
- `https://www.chatgpt.com/*`
- `https://chat.openai.com/*`

The ChatGPT DOM integration is isolated in `src/chatgptAdapter.ts`. If ChatGPT changes its sidebar markup and the adapter cannot find a supported title target, the extension stops after bounded retries and leaves the native title untouched.

## Build and load unpacked

From the DevFlow repository root:

```bash
npm run build:chatgpt-title-sync
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `extensions/chatgpt-title-sync`.
5. Open the extension details page and choose **Extension options** to review the settings.

The generated bundles live under `extensions/chatgpt-title-sync/dist` and are produced from the TypeScript sources by esbuild.

## Configuration

The options page provides:

- **Enable title sync** — global on/off switch. When changed, open ChatGPT tabs invalidate cached title decisions so the new setting or pattern is used on the next reconciliation.
- **Naming pattern** — default: `{{taskId}} · {{taskTitle}}`.
- **Local DevFlow URL** — defaults to `http://127.0.0.1:3000` and intentionally accepts only `http://` loopback hosts (`127.0.0.1` or `localhost`).

Supported naming tokens are:

- `{{project}}`
- `{{taskId}}`
- `{{taskTitle}}`
- `{{chatAlias}}`

Single-brace forms such as `{taskId}` are also accepted. Missing tokens are removed. Malformed or empty patterns fall back to a bounded DevFlow task title rather than producing an unusable sidebar label.

A session-level `preferredTitle`, when present, takes precedence over the configured pattern. This lets future DevFlow project/session policy choose a title without coupling that display value to identity.

## Conversation association contract

The extension deliberately does **not** infer DevFlow ownership by reading ChatGPT message content. A conversation must first be explicitly associated with a DevFlow execution session.

DevFlow stores this presentation association as execution-session evidence with these fields:

- `executionSessionId`
- `conversationId`
- optional `chatAlias`
- optional `preferredTitle`

The local binding endpoint is:

```text
POST /api/chat-sessions/title-bindings
```

Example body:

```json
{
  "executionSessionId": "exec-...",
  "conversationId": "<ChatGPT conversation id>",
  "chatAlias": "Claim race",
  "preferredTitle": "DVF-0756 · Fix claim race"
}
```

Once an association exists, the extension resolves only the presentation metadata it needs through:

```text
GET /api/chat-sessions/title?conversationId=<id>
```

The current extension does not guess an execution session when a conversation is unresolved. That is intentional because multiple DevFlow chats may run in parallel; choosing a recent session heuristically could rename the wrong ChatGPT conversation. The DevFlow integration that knows both identifiers is responsible for creating the binding.

## Rename behavior and race protection

ChatGPT may generate its own title shortly after a conversation is created. The content script therefore:

1. Detects a supported `/c/<conversationId>` navigation.
2. Resolves the desired DevFlow title through the extension background worker.
3. Finds the matching sidebar entry through the isolated adapter.
4. Waits for the current native title to remain stable for a short period.
5. Applies the desired title only when it differs.
6. Allows only a bounded number of reapplications if ChatGPT later overwrites the title.

MutationObserver work is debounced and retries are capped. Repeated DOM events with the already-applied title are no-ops, preventing rename loops and flicker.

## Privacy and permissions

The manifest requests only:

- `storage` — for the enable flag, pattern, and local DevFlow URL.
- loopback host access for `http://127.0.0.1/*` and `http://localhost/*`.
- content-script access to the supported ChatGPT web origins.

The extension does not read or transmit ChatGPT conversation message content to generate a title. It does not store ChatGPT cookies, ChatGPT authentication tokens, or DevFlow execution identity in the visible title.

DevFlow title lookups are restricted by the extension client to loopback HTTP addresses. Remote/LAN DevFlow URLs are rejected instead of silently sending conversation identifiers off-machine.

## Failure and recovery behavior

The extension fails closed. It leaves the ChatGPT-native title untouched when:

- DevFlow is stopped or unreachable.
- the conversation has no DevFlow association.
- the local URL is invalid or outside loopback.
- browser permissions are missing.
- ChatGPT markup no longer matches the adapter.
- the title cannot become stable within the bounded retry/apply policy.

If DevFlow was temporarily unavailable or the conversation was associated after the bounded retry window, refresh the ChatGPT tab or navigate away and back after the association exists. No DevFlow task execution is blocked by title-sync failure.

## Disable or remove

To disable without uninstalling, open the extension options and clear **Enable title sync**, then save. Cached title resolutions in open supported tabs are invalidated. The extension stops applying titles, but it does not attempt to reconstruct a previous ChatGPT-generated title that may already have been replaced.

To remove the extension, open `chrome://extensions`, find **DevFlow ChatGPT Title Sync**, and choose **Remove**. DevFlow task/session data remains independent of the extension.

## Verification

Automated focused checks:

```bash
npm run test:chatgpt-title-sync
npm run build:chatgpt-title-sync
```

The focused tests cover pattern rendering/fallback, idempotent coordination, delayed ChatGPT auto-title races, bounded give-up behavior, DOM adapter failure, local URL restrictions, DevFlow unavailable/unresolved behavior, and settings-cache invalidation.

For a manual smoke test, load the unpacked extension, ensure the target ChatGPT conversation is explicitly bound to a DevFlow execution session, open that conversation, and confirm the sidebar changes to the configured title. Disable the extension and verify subsequent ChatGPT title behavior is left untouched.

## Known limitations

- ChatGPT DOM selectors are not a stable public API. Selector drift can temporarily disable title sync until `chatgptAdapter.ts` is updated.
- This implementation changes the rendered sidebar label. ChatGPT may later rerender its own persisted title; the extension intentionally retries only a bounded number of times rather than fighting the page indefinitely.
- Conversation association is explicit. The extension will not inspect messages or guess which concurrent DevFlow execution owns an unresolved ChatGPT conversation.
- Project-level naming overrides are not a separate settings layer yet; `preferredTitle` is the forward-compatible session-level override point.
