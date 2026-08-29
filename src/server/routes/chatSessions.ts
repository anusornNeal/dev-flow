import type express from 'express';
import type { ApiRouteDeps } from '../types.js';
import {
  associateChatSessionTitlePreference,
  bindChatSessionTitlePreference,
  ChatSessionTitleServiceError,
  listChatSessionPairingCandidates,
  resolveChatSessionTitle,
} from '../services/chatSessionTitleService.js';

function sendServiceError(res: express.Response, error: unknown) {
  if (error instanceof ChatSessionTitleServiceError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: 'Chat session title metadata could not be processed.', code: 'CHAT_TITLE_SERVICE_FAILED' });
}

export function registerChatSessionRoutes(app: express.Express, _deps: ApiRouteDeps) {
  app.get('/api/chat-sessions/title', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(resolveChatSessionTitle(req.query?.conversationId));
  });

  app.get('/api/chat-sessions/title-candidates', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(listChatSessionPairingCandidates(req.query?.conversationId));
  });

  app.post('/api/chat-sessions/title-bindings', (req, res) => {
    try {
      const result = bindChatSessionTitlePreference({
        executionSessionId: req.body?.executionSessionId,
        conversationId: req.body?.conversationId,
        chatAlias: req.body?.chatAlias,
        preferredTitle: req.body?.preferredTitle,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

  app.post('/api/chat-sessions/title-associations', (req, res) => {
    try {
      const result = associateChatSessionTitlePreference({
        executionSessionId: req.body?.executionSessionId,
        conversationId: req.body?.conversationId,
        previousExecutionSessionId: req.body?.previousExecutionSessionId,
        source: req.body?.source,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) {
      return sendServiceError(res, error);
    }
  });
}
