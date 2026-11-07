import { useState, useCallback, useRef, useEffect } from "react"
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition"
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio"
import * as FileSystem from "expo-file-system"
import { useConnections } from "../stores/connections"

interface SpeechState {
  listening: boolean
  transcript: string
  error: string | null
}

interface SpeechActions {
  start: () => Promise<void>
  stop: () => void
  cancel: () => void
}

// 16 kHz mono keeps uploads small; the STT bridge resamples anyway, but
// recording at the target rate avoids a lossy double conversion.
const VOICE_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
}

export function useSpeech(onResult: (text: string) => void): SpeechState & SpeechActions {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = useRef("")
  const recorder = useAudioRecorder(VOICE_OPTIONS)
  // cancel() stops the recording but must not deliver its transcript.
  const discard = useRef(false)
  const useFallback = useRef(false)

  useSpeechRecognitionEvent("start", () => {
    setListening(true)
    setError(null)
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("end", () => {
    setListening(false)
    // Deliver final transcript
    if (pending.current.trim()) {
      onResult(pending.current.trim())
    }
    setTranscript("")
    pending.current = ""
  })

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results[0]?.transcript || ""
    pending.current = text
    setTranscript(text)
  })

  useSpeechRecognitionEvent("error", (event) => {
    // "no-speech" is not really an error — user just didn't say anything
    if (event.error === "no-speech") {
      setListening(false)
      return
    }
    setError(event.message || event.error)
    setListening(false)
  })

  const start = useCallback(async () => {
    // Justified try/catch: on devices without a speech-recognizer service
    // (several Android 10-12 ROMs) a bare start() call throws natively and
    // kills the app. Surface it through the same error alert as other failures.
    try {
      // Feature-detected: availability check is Android-only in the module.
      if (typeof ExpoSpeechRecognitionModule.isRecognitionAvailable === "function") {
        const available = await ExpoSpeechRecognitionModule.isRecognitionAvailable()
        if (!available) {
          await startFallback()
          return
        }
      }
      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (!result.granted) {
        setError("Microphone permission denied")
        return
      }
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [startFallback])

  const stop = useCallback(() => {
    if (useFallback.current) {
      void stopFallback()
      return
    }
    ExpoSpeechRecognitionModule.stop()
  }, [stopFallback])

  const cancel = useCallback(() => {
    pending.current = ""
    if (useFallback.current) {
      discard.current = true
      void recorder.stop()
      void setAudioModeAsync({ allowsRecording: false })
      setListening(false)
      setTranscript("")
      return
    }
    ExpoSpeechRecognitionModule.abort()
    setListening(false)
    setTranscript("")
  }, [recorder])

  // Stop the native recognition session when the screen unmounts — otherwise
  // the mic stays hot in the background. abort() is a no-op when not listening.
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort()
    }
  }, [])

  // --- Fallback for devices without a system speech recognizer (e.g. Huawei
  // without Google services): record with expo-audio and send the file to the
  // opencode voice-stt bridge, which transcribes via local Handy/GigaAM.

  async function startFallback() {
    const base = useConnections.getState().clientBase
    if (!base) {
      setError("Speech recognition is not available on this device")
      return
    }
    const permission = await AudioModule.requestRecordingPermissionsAsync()
    if (!permission.granted) {
      setError("Microphone permission denied")
      return
    }
    useFallback.current = true
    discard.current = false
    setError(null)
    setTranscript("")
    pending.current = ""
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
    await recorder.prepareToRecordAsync()
    recorder.record()
    setListening(true)
  }

  async function stopFallback() {
    const discardThis = discard.current
    discard.current = false
    try {
      await recorder.stop()
    } finally {
      useFallback.current = false
      void setAudioModeAsync({ allowsRecording: false })
      setListening(false)
      setTranscript("")
    }
    const uri = recorder.uri
    console.log(`[voice] recorded uri: ${uri}`)
    if (discardThis || !uri) return
    const base = useConnections.getState().clientBase
    if (!base) {
      setError("Speech recognition is not available on this device")
      return
    }
    // Justified try/catch: network/server failures here must degrade to the
    // shared error alert instead of crashing the session screen.
    try {
      const text = await transcribeOnServer(uri, base)
      console.log(`[voice] transcribed: ${text.slice(0, 80)}`)
      if (text.trim()) onResult(text.trim())
    } catch (err) {
      console.warn("[voice] failed:", err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return { listening, transcript, error, start, stop, cancel }
}

interface SttBase {
  baseUrl: string
  auth?: { username: string; password: string }
}

// The voice-stt plugin listens on port 4097 on the same host as the opencode
// server and accepts the same Basic credentials. Built with string ops —
// Hermes `new URL` support must not be assumed here.
function sttEndpoint(baseUrl: string): string {
  const m = baseUrl.match(/^(https?:\/\/)([^/:?#]+)(?::(\d+))?(?:\/.*)?$/)
  if (!m) return `${baseUrl.replace(/\/+$/, "")}/transcribe`
  return `${m[1]}${m[2]}:4097/transcribe`
}

async function transcribeOnServer(uri: string, base: SttBase): Promise<string> {
  const endpoint = sttEndpoint(base.baseUrl)
  const headers: Record<string, string> = {}
  if (base.auth) {
    headers.Authorization = `Basic ${btoa(`${base.auth.username}:${base.auth.password}`)}`
  }
  console.log(`[voice] uploading ${uri} -> ${endpoint}`)
  const res = await FileSystem.uploadAsync(endpoint, uri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers,
  })
  console.log(`[voice] status ${res.status} body: ${res.body.slice(0, 200)}`)
  const data = JSON.parse(res.body) as { text?: string; error?: string }
  if (res.status !== 200) {
    throw new Error(data.error || `Voice server error ${res.status}`)
  }
  return data.text ?? ""
}
