const {
  buildTranscriptionParams,
  assessTranscriptQuality,
  capabilitiesFor,
  parseKeywords,
  normalizeLanguage,
  LYRIC_BIAS_PROMPT,
  MAX_KEYWORDS,
} = require('../../lib/transcription');

const base = { file: 'FILE', model: 'gpt-transcribe' };

describe('buildTranscriptionParams()', () => {
  it('sends the levers the original call left unused', () => {
    const params = buildTranscriptionParams(base);

    expect(params.file).toBe('FILE');
    expect(params.model).toBe('gpt-transcribe');
    expect(params.prompt).toBe(LYRIC_BIAS_PROMPT);
    // Not "be deterministic": at 0 the API escalates on its own via logprobs.
    expect(params.temperature).toBe(0);
    // Unset, the clip is transcribed as one block with no loudness normalization.
    expect(params.chunking_strategy).toBe('auto');
  });

  it('biases decoding toward sung lyrics rather than conversation', () => {
    expect(LYRIC_BIAS_PROMPT).toMatch(/lyrics/i);
    expect(LYRIC_BIAS_PROMPT).toMatch(/ad-libs/i);
  });

  it('passes a language hint through, normalized', () => {
    expect(buildTranscriptionParams({ ...base, language: '  EN ' }).language).toBe('en');
  });

  it('drops a language code the ISO registry does not know', () => {
    // Better to lose the hint than to send a code the API 400s on.
    expect(buildTranscriptionParams({ ...base, language: 'xx' }).language).toBeUndefined();
    expect(buildTranscriptionParams({ ...base, language: 'english' }).language).toBeUndefined();
    expect(buildTranscriptionParams({ ...base, language: '<script>' }).language).toBeUndefined();
  });

  it('passes caller keywords to a model that supports them', () => {
    const params = buildTranscriptionParams({ ...base, keywords: ['Zay', 'no cap'] });
    expect(params.keywords).toEqual(['Zay', 'no cap']);
  });

  it('omits keywords entirely rather than sending an empty array', () => {
    expect(buildTranscriptionParams({ ...base, keywords: [] }).keywords).toBeUndefined();
    expect(buildTranscriptionParams(base).keywords).toBeUndefined();
  });

  it('lets chunking be turned off for comparison', () => {
    const params = buildTranscriptionParams({ ...base, chunkingDisabled: true });
    expect(params.chunking_strategy).toBeUndefined();
  });

  describe('per-model support — an unsupported parameter is a 400', () => {
    it('withholds keywords and chunking from whisper-1', () => {
      const params = buildTranscriptionParams({
        file: 'F', model: 'whisper-1', keywords: ['Zay'], language: 'en',
      });

      expect(params.keywords).toBeUndefined();
      expect(params.chunking_strategy).toBeUndefined();
      expect(params.prompt).toBe(LYRIC_BIAS_PROMPT);
      expect(params.language).toBe('en');
    });

    it('withholds keywords from the 4o transcribe models', () => {
      for (const model of ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']) {
        const params = buildTranscriptionParams({ file: 'F', model, keywords: ['Zay'] });
        expect(params.keywords).toBeUndefined();
        expect(params.chunking_strategy).toBe('auto');
      }
    });

    it('withholds the prompt from the diarizing model, which rejects it', () => {
      const params = buildTranscriptionParams({ file: 'F', model: 'gpt-4o-transcribe-diarize' });
      expect(params.prompt).toBeUndefined();
    });

    it('falls back to the conservative set for an unrecognized model', () => {
      const params = buildTranscriptionParams({
        file: 'F', model: 'some-future-model', keywords: ['Zay'], language: 'en',
      });

      expect(params.keywords).toBeUndefined();
      expect(params.chunking_strategy).toBeUndefined();
      expect(params.prompt).toBe(LYRIC_BIAS_PROMPT);
      expect(params.language).toBe('en');
    });

    it('treats an unknown model as unknown, not as the default', () => {
      expect(capabilitiesFor('some-future-model').keywords).toBe(false);
      expect(capabilitiesFor('gpt-transcribe').keywords).toBe(true);
    });
  });
});

describe('parseKeywords()', () => {
  it('splits on commas and newlines, keeping multi-word phrases', () => {
    expect(parseKeywords('Zay, no cap\nskrrt , 4L')).toEqual(['Zay', 'no cap', 'skrrt', '4L']);
  });

  it('drops blanks and non-strings', () => {
    expect(parseKeywords(',, ,\n')).toEqual([]);
    expect(parseKeywords(undefined)).toEqual([]);
    expect(parseKeywords(['a'])).toEqual([]);
  });

  it('bounds the count and the length of each entry', () => {
    const many = parseKeywords(Array.from({ length: 200 }, (_, i) => 'w' + i).join(','));
    expect(many).toHaveLength(MAX_KEYWORDS);

    const [long] = parseKeywords('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(60);
  });
});

describe('assessTranscriptQuality()', () => {
  it('calls an empty transcript empty', () => {
    expect(assessTranscriptQuality({ transcriptChars: 0, durationSeconds: 30 }).verdict).toBe('empty');
  });

  it('flags a transcript far too short for the length of audio', () => {
    // 20 characters from 30 seconds: the model heard the beat, not the vocal.
    const quality = assessTranscriptQuality({ transcriptChars: 20, durationSeconds: 30 });

    expect(quality.verdict).toBe('low');
    expect(quality.note).toMatch(/paste the lyrics/i);
  });

  it('accepts a normal yield', () => {
    expect(assessTranscriptQuality({ transcriptChars: 900, durationSeconds: 30 }).verdict).toBe('ok');
    expect(assessTranscriptQuality({ transcriptChars: 900, durationSeconds: 30 }).note).toBe('');
  });

  it('does not guess when the duration is missing or implausible', () => {
    // A transcript comfortably over the absolute floor, so only the duration
    // is under test here.
    for (const durationSeconds of [undefined, null, 0, -5, NaN, '30']) {
      expect(assessTranscriptQuality({ transcriptChars: 400, durationSeconds }).verdict).toBe('unknown');
    }
  });

  it('does not judge a clip too short for the rate to mean anything', () => {
    expect(assessTranscriptQuality({ transcriptChars: 400, durationSeconds: 3 }).verdict).toBe('unknown');
  });

  it('flags too little text to read a style from, with or without a duration', () => {
    // The gate cannot depend on the browser managing to decode the clip.
    for (const durationSeconds of [undefined, 45, 3]) {
      const quality = assessTranscriptQuality({ transcriptChars: 8, durationSeconds });
      expect(quality.verdict).toBe('low');
      expect(quality.note).toMatch(/too little to read a cadence/i);
    }
  });

  it('accepts a short but analyzable transcript when no duration is known', () => {
    expect(assessTranscriptQuality({ transcriptChars: 200 }).verdict).toBe('unknown');
  });
});
