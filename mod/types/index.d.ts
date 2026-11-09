export type Phase =
  | 'off'
  | 'loading'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'speaking'
  | 'busy'
  | 'restarting'
  | 'error'
  | 'not-installed'

/** One open Claude session, as the sessions pane lists it. */
export type VoiceSession = {
  id: string
  /** `project · branch` (Desktop's titles are not readable by mods); a short id added when two share it. */
  name: string
  isSelf: boolean
  /** Voice input goes here. */
  isTarget: boolean
  /** Its listener holds the mic. */
  hasMic: boolean
}

/** What the band shows beside the phase. */
export type BandView = {
  /** The line the listener speaks (`listener/said`). */
  said: string
  /** The listener's last stderr line when it died. */
  err: string
  /** Seconds into the recording. */
  elapsed: number
}

declare module 'claude-code' {
  interface PluginState {
    'voice-wake': {
      phase: Shaped<Phase>
      sessions: Shaped<VoiceSession[]>
      view: Shaped<BandView>
    }
  }
}
