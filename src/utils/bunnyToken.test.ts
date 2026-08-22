import { isAllowedBunnyUrl, signBunnyCdnUrl } from './bunnyToken';

describe('Bunny CDN playback tokens', () => {
  it('signs the exact path with a short expiry and no secret leakage', () => {
    const signed = signBunnyCdnUrl(
      'https://demo-zone.b-cdn.net/videos/lesson.mp4',
      'private-token-key',
      90,
      1_700_000_000_000,
    );
    const url = new URL(signed.url);
    expect(url.searchParams.get('expires')).toBe('1700000090');
    expect(url.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signed.url).not.toContain('private-token-key');
  });

  it('allows only the exact configured pull-zone host', () => {
    expect(isAllowedBunnyUrl('https://demo-zone.b-cdn.net/a.mp4', 'https://demo-zone.b-cdn.net')).toBe(true);
    expect(isAllowedBunnyUrl('https://evil-demo-zone.b-cdn.net/a.mp4', 'https://demo-zone.b-cdn.net')).toBe(false);
  });
});
