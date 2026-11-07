import { useState, useCallback, useRef, useEffect } from "react"
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition"

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

export function useSpeech(onResult: (text: string) => void): SpeechState & SpeechActions {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [error, setError] = useState<string | null>(null)
  const pending = useRef("")

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
          setError("Speech recognition is not available on this device")
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
  }, [])

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop()
  }, [])

  const cancel = useCallback(() => {
    pending.current = ""
    ExpoSpeechRecognitionModule.abort()
    setListening(false)
    setTranscript("")
  }, [])

  // Stop the native recognition session when the screen unmounts — otherwise
  // the mic stays hot in the background. abort() is a no-op when not listening.
  useEffect(() => {
    return () => {
      ExpoSpeechRecognitionModule.abort()
    }
  }, [])

  return { listening, transcript, error, start, stop, cancel }
}
