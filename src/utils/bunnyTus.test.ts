import crypto from 'crypto';
import { createBunnyTusTicket } from './bunnyTus';

describe('createBunnyTusTicket', () => {
  it('matches Bunny Stream signature format and never returns the API key', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const ticket = createBunnyTusTicket({
      libraryId: '12345',
      videoId: 'video-guid',
      apiKey: 'server-only-secret',
      expiresAt,
    });
    const expected = crypto
      .createHash('sha256')
      .update(`12345server-only-secret${expiresAt}video-guid`)
      .digest('hex');

    expect(ticket).toEqual({
      authorizationSignature: expected,
      authorizationExpire: expiresAt,
    });
    expect(JSON.stringify(ticket)).not.toContain('server-only-secret');
  });

  it('rejects missing inputs and expired tickets', () => {
    expect(() =>
      createBunnyTusTicket({ libraryId: '', videoId: 'v', apiKey: 'k' })
    ).toThrow('inputs are required');
    expect(() =>
      createBunnyTusTicket({
        libraryId: '1',
        videoId: 'v',
        apiKey: 'k',
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      })
    ).toThrow('future Unix timestamp');
  });
});
