/**
 * useVoiceConversation — seamless speech-to-speech conversation loop
 *
 * Record (expo-av / MediaRecorder) → /api/stt → text
 * Text → sendMessage() (existing chat pipeline)
 * Response text → /api/tts → audio playback → auto-listen again
 *
 * Features:
 * - Voice Activity Detection (VAD): auto-stops recording after silence
 * - Conversation loop: after TTS finishes, auto-starts listening again
 * - Single tap to start, tap again anytime to exit
 *
 * Supports: iOS, Android, and Web.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

// ── Types ──

export type VoiceState =
  | 'idle'        // Waiting for user to tap
  | 'listening'   // Recording user speech
  | 'processing'  // STT in progress
  | 'thinking'    // Waiting for Claude
  | 'speaking'    // Playing TTS response
  | 'error';

interface UseVoiceConversationOptions {
  /** Called with transcribed text — should trigger sendMessage() */
  onTranscript: (text: string) => void;
  /** Called when voice state changes */
  onStateChange?: (state: VoiceState) => void;
  /** Whether to auto-play TTS for responses */
  autoPlayResponse?: boolean;
  /** Silence duration (ms) before auto-stopping recording. Default: 1500 */
  silenceTimeout?: number;
  /** Amplitude threshold below which audio is considered silence. Default: 0.05 */
  silenceThreshold?: number;
}

interface UseVoiceConversationReturn {
  voiceState: VoiceState;
  /** Start recording */
  startListening: () => Promise<void>;
  /** Stop recording and transcribe */
  stopListening: () => Promise<void>;
  /** Toggle recording on/off — also starts/stops conversation loop */
  toggleListening: () => Promise<void>;
  /** Speak text aloud via TTS */
  speak: (text: string) => Promise<void>;
  /** Stop any current speech playback */
  stopSpeaking: () => void;
  /** Whether voice is supported on this platform */
  isSupported: boolean;
  /** Current error message, if any */
  errorMessage: string | null;
  /** Amplitude level 0-1 for visualisation (updated during recording) */
  amplitude: number;
  /** Whether the conversation loop is active */
  conversationActive: boolean;
}

// ── Recording abstraction ──
// Uses expo-av on native, MediaRecorder on web

interface Recorder {
  start: () => Promise<void>;
  stop: () => Promise<{ base64: string; mimeType: string }>;
  getAmplitude: () => Promise<number>;
  cleanup: () => void;
}

async function createNativeRecorder(): Promise<Recorder> {
  const { Audio } = await import('expo-av');

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });

  const { recording } = await Audio.Recording.createAsync({
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  return {
    start: async () => {
      // Recording already started via createAsync
    },
    stop: async () => {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) throw new Error('No recording URI');

      // Read file as base64 via fetch (avoids expo-file-system API differences)
      const response = await fetch(uri);
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          // Strip the data:...;base64, prefix
          const b64 = dataUrl.split(',')[1] || '';
          resolve(b64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      return { base64, mimeType: 'audio/m4a' };
    },
    getAmplitude: async () => {
      try {
        const status = await recording.getStatusAsync();
        // metering returns dB, normalise to 0-1
        const db = (status as any).metering ?? -160;
        return Math.max(0, Math.min(1, (db + 60) / 60));
      } catch {
        return 0;
      }
    },
    cleanup: () => {
      recording.stopAndUnloadAsync().catch(() => {});
    },
  };
}

function createWebRecorder(): Recorder {
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let audioContext: AudioContext | null = null;

  return {
    start: async () => {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      // Set up analyser for amplitude
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      mediaRecorder.start(100); // collect in 100ms chunks
    },
    stop: async () => {
      return new Promise((resolve, reject) => {
        if (!mediaRecorder) {
          reject(new Error('No recorder'));
          return;
        }
        mediaRecorder.onstop = async () => {
          const blob = new Blob(chunks, { type: mediaRecorder!.mimeType });
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = btoa(
            new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
          );
          // Clean up
          stream?.getTracks().forEach(t => t.stop());
          audioContext?.close().catch(() => {});
          resolve({ base64, mimeType: 'audio/webm' });
        };
        mediaRecorder.stop();
      });
    },
    getAmplitude: async () => {
      if (!analyser) return 0;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      return Math.min(1, avg / 128);
    },
    cleanup: () => {
      try { mediaRecorder?.stop(); } catch {}
      stream?.getTracks().forEach(t => t.stop());
      audioContext?.close().catch(() => {});
    },
  };
}

// ── Audio playback for TTS ──

function createAudioPlayer() {
  let currentAudio: HTMLAudioElement | null = null;
  let nativeSound: any = null;

  return {
    play: async (audioBase64: string, mimeType: string, onEnd?: () => void) => {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        // Web: use Audio element
        const blob = new Blob(
          [Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))],
          { type: mimeType }
        );
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.onended = () => {
          URL.revokeObjectURL(url);
          onEnd?.();
        };
        currentAudio.onerror = () => {
          URL.revokeObjectURL(url);
          onEnd?.();
        };
        await currentAudio.play();
      } else {
        // Native: use expo-av
        const { Audio } = await import('expo-av');
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });
        const { sound } = await Audio.Sound.createAsync(
          { uri: `data:${mimeType};base64,${audioBase64}` },
          { shouldPlay: true }
        );
        nativeSound = sound;
        sound.setOnPlaybackStatusUpdate((status: any) => {
          if (status.didJustFinish) {
            sound.unloadAsync().catch(() => {});
            onEnd?.();
          }
        });
      }
    },
    stop: () => {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = '';
        currentAudio = null;
      }
      if (nativeSound) {
        nativeSound.stopAsync().catch(() => {});
        nativeSound.unloadAsync().catch(() => {});
        nativeSound = null;
      }
    },
  };
}

// ── Main hook ──

export function useVoiceConversation({
  onTranscript,
  onStateChange,
  autoPlayResponse = true,
  silenceTimeout = 1500,
  silenceThreshold = 0.05,
}: UseVoiceConversationOptions): UseVoiceConversationReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const [conversationActive, setConversationActive] = useState(false);

  const recorderRef = useRef<Recorder | null>(null);
  const playerRef = useRef(createAudioPlayer());
  const amplitudeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  // Track whether the conversation loop is active (ref for use in callbacks)
  const conversationActiveRef = useRef(false);
  // VAD: track consecutive silent frames
  const silentSinceRef = useRef<number | null>(null);
  // Track if we've detected any speech during this recording session
  const speechDetectedRef = useRef(false);
  // Minimum recording duration (ms) before VAD can stop
  const MIN_RECORD_DURATION = 500;
  const recordStartRef = useRef<number>(0);
  // Prevent concurrent stopListening calls
  const stoppingRef = useRef(false);

  // Check platform support
  const isSupported = Platform.OS === 'ios' || Platform.OS === 'android' ||
    (Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      conversationActiveRef.current = false;
      recorderRef.current?.cleanup();
      playerRef.current.stop();
      if (amplitudeTimerRef.current) clearInterval(amplitudeTimerRef.current);
    };
  }, []);

  const updateState = useCallback((state: VoiceState) => {
    if (!mountedRef.current) return;
    setVoiceState(state);
    onStateChange?.(state);
  }, [onStateChange]);

  // ── Get auth token ──
  const getToken = async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  };

  // ── Stop the entire conversation loop ──
  const endConversation = useCallback(() => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    // Stop any in-progress recording
    if (recorderRef.current) {
      recorderRef.current.cleanup();
      recorderRef.current = null;
    }
    // Stop amplitude polling
    if (amplitudeTimerRef.current) {
      clearInterval(amplitudeTimerRef.current);
      amplitudeTimerRef.current = null;
    }
    setAmplitude(0);
    // Stop any playback
    playerRef.current.stop();
    // Reset VAD
    silentSinceRef.current = null;
    speechDetectedRef.current = false;
    stoppingRef.current = false;
    updateState('idle');
  }, [updateState]);

  // ── Start recording ──
  const startListening = useCallback(async () => {
    if (!conversationActiveRef.current && !mountedRef.current) return;
    try {
      setErrorMessage(null);
      silentSinceRef.current = null;
      speechDetectedRef.current = false;
      stoppingRef.current = false;
      recordStartRef.current = Date.now();

      // Create platform-appropriate recorder
      const recorder = Platform.OS === 'web'
        ? createWebRecorder()
        : await createNativeRecorder();

      recorderRef.current = recorder;
      await recorder.start();
      updateState('listening');

      // Start amplitude polling for visualisation + VAD
      amplitudeTimerRef.current = setInterval(async () => {
        if (!mountedRef.current) return;
        const amp = await recorder.getAmplitude();
        setAmplitude(amp);

        // ── Voice Activity Detection ──
        // Only engage VAD if conversation loop is active
        if (!conversationActiveRef.current) return;
        // Don't auto-stop too early
        if (Date.now() - recordStartRef.current < MIN_RECORD_DURATION) return;

        if (amp > silenceThreshold) {
          // User is speaking
          speechDetectedRef.current = true;
          silentSinceRef.current = null;
        } else if (speechDetectedRef.current) {
          // User was speaking but now it's silent — start silence timer
          if (silentSinceRef.current === null) {
            silentSinceRef.current = Date.now();
          } else if (Date.now() - silentSinceRef.current >= silenceTimeout) {
            // Silence has lasted long enough — auto-stop
            if (!stoppingRef.current) {
              stoppingRef.current = true;
              // Clear interval before stopping to prevent re-entry
              if (amplitudeTimerRef.current) {
                clearInterval(amplitudeTimerRef.current);
                amplitudeTimerRef.current = null;
              }
              // Use setTimeout to avoid calling stopListening inside the interval
              setTimeout(() => {
                stopListeningInternal();
              }, 0);
            }
          }
        }
      }, 100);
    } catch (err: any) {
      console.error('[voice] Recording start failed:', err?.message);
      setErrorMessage('Microphone access denied. Please enable it in settings.');
      updateState('error');
      // If in conversation mode, exit on mic error
      if (conversationActiveRef.current) {
        endConversation();
      }
    }
  }, [updateState, silenceThreshold, silenceTimeout, endConversation]);

  // ── Stop recording and transcribe (internal, no conversation-end logic) ──
  const stopListeningInternal = useCallback(async () => {
    // Stop amplitude polling
    if (amplitudeTimerRef.current) {
      clearInterval(amplitudeTimerRef.current);
      amplitudeTimerRef.current = null;
    }
    setAmplitude(0);
    silentSinceRef.current = null;

    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;

    try {
      updateState('processing');
      const { base64, mimeType } = await recorder.stop();

      // Send to STT endpoint
      const token = await getToken();
      if (!token) {
        setErrorMessage('Not authenticated');
        updateState('error');
        setTimeout(() => {
          if (mountedRef.current) updateState('idle');
        }, 2000);
        return;
      }

      const res = await fetch('/api/stt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ audio: base64, mimeType }),
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.text) {
        setErrorMessage(data.error || 'Could not understand audio');
        updateState('error');
        // In conversation mode, auto-recover by listening again
        setTimeout(() => {
          if (mountedRef.current && conversationActiveRef.current) {
            startListening();
          } else if (mountedRef.current) {
            updateState('idle');
          }
        }, 1500);
        return;
      }

      // We have text — pass to chat
      updateState('thinking');
      onTranscript(data.text);
    } catch (err: any) {
      console.error('[voice] Transcription failed:', err?.message);
      setErrorMessage('Failed to process audio');
      updateState('error');
      setTimeout(() => {
        if (mountedRef.current && conversationActiveRef.current) {
          startListening();
        } else if (mountedRef.current) {
          updateState('idle');
        }
      }, 2000);
    }
  }, [onTranscript, updateState, startListening]);

  // ── Public stop listening (also used for manual stop) ──
  const stopListening = useCallback(async () => {
    stoppingRef.current = true;
    await stopListeningInternal();
  }, [stopListeningInternal]);

  // ── Toggle — starts or stops the conversation loop ──
  const toggleListening = useCallback(async () => {
    if (conversationActiveRef.current) {
      // User tapped mic while conversation is active — end the loop
      endConversation();
      return;
    }

    // Start conversation loop
    conversationActiveRef.current = true;
    setConversationActive(true);

    if (voiceState === 'idle' || voiceState === 'error') {
      await startListening();
    }
  }, [voiceState, startListening, endConversation]);

  // ── Speak response via TTS ──
  // After TTS finishes, auto-starts listening if conversation is active
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    // If conversation was ended while waiting, don't speak
    if (!conversationActiveRef.current && !mountedRef.current) return;

    try {
      updateState('speaking');
      const token = await getToken();

      // Strip markdown for cleaner speech
      const clean = text.replace(/[*_~`#>\[\]()]/g, '').replace(/\n+/g, '. ');

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ text: clean }),
      });

      if (!res.ok) {
        console.warn('[voice] TTS failed:', res.status);
        // Auto-listen again if conversation is still active
        if (mountedRef.current && conversationActiveRef.current) {
          await startListening();
        } else if (mountedRef.current) {
          updateState('idle');
        }
        return;
      }

      const arrayBuffer = await res.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      await playerRef.current.play(base64, 'audio/mpeg', () => {
        if (!mountedRef.current) return;
        // ── Conversation loop: after speaking, auto-listen again ──
        if (conversationActiveRef.current) {
          startListening();
        } else {
          updateState('idle');
        }
      });
    } catch (err: any) {
      console.warn('[voice] TTS playback error:', err?.message);
      if (mountedRef.current && conversationActiveRef.current) {
        startListening();
      } else if (mountedRef.current) {
        updateState('idle');
      }
    }
  }, [updateState, startListening]);

  // ── Stop speaking ──
  const stopSpeaking = useCallback(() => {
    playerRef.current.stop();
    if (conversationActiveRef.current) {
      // If conversation is active and user interrupts TTS, start listening
      startListening();
    } else {
      updateState('idle');
    }
  }, [updateState, startListening]);

  return {
    voiceState,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
    isSupported,
    errorMessage,
    amplitude,
    conversationActive,
  };
}
