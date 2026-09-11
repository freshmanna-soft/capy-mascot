// Rejects near-silence/noise hallucinations common to STT backends —
// ported from agentic-chat/voice/stt.py's clean_transcript. Originally only
// applied to the local whisper.cpp path, but Watson hallucinates on
// background noise too (less often, but a cough or a chair creak can come
// back as "Thank you." or a stray word) — this now applies uniformly to
// both backends so neither one passes noise off as something to reply to.
//
// 'bye', 'okay' and 'ok' were in this list and have been deliberately
// removed: they are words a user says ON PURPOSE, and filtering them broke
// two real things. A spoken "bye" was erased to '' and could only end a
// conversation by accident, via the silence path; a spoken "okay" was erased
// before chat.js's CONFIRM_RE ever saw it, so it could never confirm a staged
// trigger_build/create_github_issue. Whisper does still sometimes hallucinate
// "Okay." on near-silence, but the renderer's adaptive VAD now covers that
// case upstream — a turn only counts as speech after MIN_SPEECH_MS of
// sustained above-noise-floor audio, so pure silence rarely reaches here.
const HALLUCINATIONS = new Set([
  '', 'you', 'thanks for watching', 'thank you for watching',
  'mm', 'mmm', 'hmm', 'uh', 'um', 'ah', 'so',
  '[blank_audio]', '(silence)', '[silence]', '[music]', '(buzzing)',
  'please subscribe', 'subtitles by the amara.org community',
]);

function cleanTranscript(raw) {
  const text = (raw || '').split(/\s+/).filter(Boolean).join(' ').trim();
  if (!text) return '';
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('(') && text.endsWith(')'))) return '';
  if (HALLUCINATIONS.has(text.toLowerCase().replace(/[.,!?]+$/, ''))) return '';
  return text;
}

// Explicit "I'm done talking to you" intent. Deliberately deterministic
// keyword matching rather than asking the model whether the user said goodbye
// — same reasoning as chat.js's CONFIRM_RE/CANCEL_RE gate: a small, auditable
// surface beats an LLM judgment call for something that ends the session.
//
// Before this existed, the ONLY way a conversation could end was an empty
// transcript, which meant actually saying goodbye did nothing while a single
// quiet turn ended everything. This is the real signal; silence is the backup.
// Composed from parts so the shape is legible: a sign-off has to be
// essentially the WHOLE utterance, not merely contained somewhere in it.
// Matching a bare `\blater\b` anywhere turned "later today can you start a
// build" into a goodbye, and `\bbye\b` did the same to "bye the way, what's
// up" — hence the anchors and the explicit lists of what may surround the
// sign-off rather than a loose word search.
const PRE = String.raw`(?:(?:ok|okay|alright|all ?right|cool|right|well|great|thanks|thank you|and|so|um|uh)[\s,]+)*`;
const POST = String.raw`(?:[\s,]+(?:capy|now|for now|for today|then|man|dude|buddy|guys|everyone|later|thanks|thank you))*`;
const TAIL = String.raw`[\s,!.]*$`;
const SIGNOFF = String.raw`(?:bye bye|bye|goodbye|good ?bye|good ?night|see ya|see you|later|peace|ciao|adios)`;
const CLOSER = String.raw`(?:that'?s (?:all|it|everything)|that is (?:all|it|everything)|that'?ll be all|that will be all|nothing else|no more questions|i'?m (?:all )?(?:done|good|set|finished)|i am (?:all )?(?:done|good|set|finished)|we'?re (?:all )?done|we are (?:all )?done|all done)`;

const GOODBYE_PATTERNS = [
  new RegExp(`^${PRE}${SIGNOFF}${POST}${TAIL}`),
  new RegExp(`^${PRE}${CLOSER}${POST}${TAIL}`),
  // These phrases are distinctive enough to spot anywhere in a short
  // utterance — nothing else says "talk to you later".
  /\b(?:talk (?:to you )?later|talk soon|catch you later|speak (?:to you )?later)\b/,
  // A bare thanks reads as a sign-off; anchored so "thanks, what about the
  // PR?" stays a real question.
  /^(?:thanks|thank you|thanks a lot|thanks capy|thank you capy|thx)[\s,!.]*$/,
];

// A goodbye is a SHORT utterance. "I told him bye and then he left" contains a
// sign-off word but plainly isn't one, so anything longer than this is treated
// as normal speech no matter what it contains.
const MAX_GOODBYE_WORDS = 7;

function isGoodbye(raw) {
  const text = (raw || '').trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (!text) return false;
  if (text.split(/\s+/).length > MAX_GOODBYE_WORDS) return false;
  return GOODBYE_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { cleanTranscript, isGoodbye };
