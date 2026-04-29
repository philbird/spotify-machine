import express from 'express';
import { authorizeUrl, clearTokens, exchangeCodeForTokens, getStoredTokens, newState } from '../../spotify/auth.js';
import { getCurrentUser } from '../../spotify/fetchers.js';

export const authRouter = express.Router();

const pendingStates = new Set<string>();

authRouter.get('/login', (_req, res) => {
  const state = newState();
  pendingStates.add(state);
  res.json({ url: authorizeUrl(state) });
});

authRouter.get('/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) return res.status(400).send(`Spotify auth error: ${error}`);
    if (!code || !state || !pendingStates.has(state)) return res.status(400).send('Invalid auth response');
    pendingStates.delete(state);
    await exchangeCodeForTokens(code);
    res.redirect('/?auth=ok');
  } catch (err) {
    next(err);
  }
});

authRouter.get('/status', async (_req, res, next) => {
  try {
    const tokens = getStoredTokens();
    if (!tokens) return res.json({ connected: false });
    try {
      const user = await getCurrentUser();
      res.json({ connected: true, user: { id: user.id, displayName: user.display_name } });
    } catch {
      res.json({ connected: true, user: null });
    }
  } catch (err) {
    next(err);
  }
});

authRouter.post('/disconnect', (_req, res) => {
  clearTokens();
  res.json({ ok: true });
});
