import { generateParentLinkCode, hashParentLinkCode } from './linkCode';

describe('verified parent link codes', () => {
  it('generates eight unambiguous characters', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateParentLinkCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });

  it('binds the digest to the student and normalizes case', () => {
    const upper = hashParentLinkCode('student-a', 'ABCD2345', 'test-secret');
    const lower = hashParentLinkCode('student-a', 'abcd2345', 'test-secret');
    expect(upper).toBe(lower);
    expect(upper).not.toBe(hashParentLinkCode('student-b', 'ABCD2345', 'test-secret'));
  });
});
