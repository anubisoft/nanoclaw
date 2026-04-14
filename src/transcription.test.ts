import { describe, expect, it } from 'vitest';

import { isLikelyNonSpeechTranscript } from './transcription.js';

describe('isLikelyNonSpeechTranscript', () => {
  it('rejects known proxy/auth noise (exact)', () => {
    expect(isLikelyNonSpeechTranscript('Not logged in')).toBe(true);
    expect(isLikelyNonSpeechTranscript('Not logged in.')).toBe(true);
    expect(isLikelyNonSpeechTranscript('  not logged in  ')).toBe(true);
    expect(isLikelyNonSpeechTranscript('Please log in')).toBe(true);
    expect(isLikelyNonSpeechTranscript('Invalid API key')).toBe(true);
  });

  it('rejects short blobs that start like login interstitials', () => {
    expect(
      isLikelyNonSpeechTranscript('Not logged in.\n\nContinue here.'),
    ).toBe(true);
  });

  it('rejects /login gateway copy without leading not logged in', () => {
    expect(isLikelyNonSpeechTranscript('Please /login to continue.')).toBe(
      true,
    );
  });

  it('allows normal speech', () => {
    expect(isLikelyNonSpeechTranscript('Hello, can you hear me?')).toBe(false);
    expect(
      isLikelyNonSpeechTranscript(
        'I am not logged in to Slack yet but will fix it.',
      ),
    ).toBe(false);
  });

  it('treats empty as non-speech', () => {
    expect(isLikelyNonSpeechTranscript('')).toBe(true);
    expect(isLikelyNonSpeechTranscript('   ')).toBe(true);
  });
});
