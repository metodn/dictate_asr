export type Phase = 'idle' | 'recording' | 'transcribing'

declare module 'claude-code' {
  interface PluginState {
    dictate: { phase: Phase; mode: boolean; server: string }
  }
}
