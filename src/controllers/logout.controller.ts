import { Router, Request, Response, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

// Simple in-memory token blacklist (for production, use Redis or database)
const tokenBlacklist: Set<string> = new Set();

export const addToBlacklist = (token: string): void => {
  tokenBlacklist.add(token);
};

export const isBlacklisted = (token: string): boolean => {
  return tokenBlacklist.has(token);
};

export const logout: RequestHandler = async (req, res): Promise<void> => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];
    
    if (token) {
      // Add to blacklist
      addToBlacklist(token);
      console.log('Token blacklisted:', token.substring(0, 20) + '...');
    }

    // Also clear any cookies if used
    res.clearCookie('token');

    res.json({ 
      message: 'Logged out successfully',
      blacklisted: !!token 
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
};

// Export middleware that checks blacklist
export const blacklistMiddleware: RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (token && isBlacklisted(token)) {
    res.status(401).json({ error: 'Token has been revoked' });
    return;
  }

  next();
};

router.post('/logout', logout);

export default router;
