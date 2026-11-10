// ---------------------------------------------------------------------------
// Voice input types
// ---------------------------------------------------------------------------

export type VoiceLanguageCode =
  | 'en'
  | 'es'
  | 'fr'
  | 'ja'
  | 'de'
  | 'pt'
  | 'it'
  | 'ko'
  | 'hi'
  | 'id'
  | 'ru'
  | 'pl'
  | 'tr'
  | 'nl'
  | 'uk'
  | 'el'
  | 'cs'
  | 'da'
  | 'sv'
  | 'no'

export interface VoiceLanguageOption {
  code: VoiceLanguageCode
  label: string
}

// Supported languages match the SDK's normalizeLanguageForSTT valid code set.
// Deepgram silently fails (connects but never transcribes) for unsupported codes.
export const VOICE_LANGUAGES: VoiceLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'ja', label: 'Japanese' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ru', label: 'Russian' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'nl', label: 'Dutch' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'el', label: 'Greek' },
  { code: 'cs', label: 'Czech' },
  { code: 'da', label: 'Danish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' }
]

export interface VoiceTranscript {
  text: string
  isFinal: boolean
}

export type VoiceState = 'idle' | 'connecting' | 'recording' | 'processing'

/**
 * How a voice message reads in the notice pill above the mic: `info` (grey) is
 * an outcome — "No speech detected"; `warn` (amber) is an error or something to
 * fix. Sent by main with each `voice:error` so the renderer never has to guess
 * from the wording (ADR-070); a message without one is `warn`.
 */
export type VoiceNoticeTone = 'info' | 'warn'

/**
 * A button the notice pill offers beside its message. Like the tone it rides the
 * wire as data, so the renderer never keys on the wording (ADR-070).
 * `install-voice-pack`: the on-device speech model is not installed (ADR-101 §6).
 */
export type VoiceNoticeAction = 'install-voice-pack'
