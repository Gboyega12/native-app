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
    start: async () => {},
    stop: async () => {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (!uri) throw new Error('No recording URI');

      const response = await fetch(uri);
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
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

      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      mediaRecorder.start(100);
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
//
// All async/timer callbacks read from refs (not useCallback closures) so they
// always see the latest values and never go stale.

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
  const conversationActiveRef = useRef(false);
  const silentSinceRef = useRef<number | null>(null);
  const speechDetectedRef = useRef(false);
  const recordStartRef = useRef<number>(0);
  const stoppingRef = useRef(false);

  // ── Keep refs in sync with latest callback props ──
  // This avoids stale closures in timers/async code.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const MIN_RECORD_DURATION = 500;

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

  // ── State update helper (always reads ref for onStateChange) ──
  const updateState = useCallback((state: VoiceState) => {
    if (!mountedRef.current) return;
    setVoiceState(state);
    onStateChangeRef.current?.(state);
  }, []); // No deps — reads from ref

  const getToken = async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  };

  // ── Core operations as plain functions stored in refs ──
  // This breaks the circular useCallback dependency chain.

  const startListeningRef = useRef<() => Promise<void>>(async () => {});
  const stopListeningInternalRef = useRef<() => Promise<void>>(async () => {});

  const clearAmplitudeTimer = useCallback(() => {
    if (amplitudeTimerRef.current) {
      clearInterval(amplitudeTimerRef.current);
      amplitudeTimerRef.current = null;
    }
    setAmplitude(0);
  }, []);

  // ── End conversation loop ──
  const endConversation = useCallback(() => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    if (recorderRef.current) {
      recorderRef.current.cleanup();
      recorderRef.current = null;
    }
    clearAmplitudeTimer();
    playerRef.current.stop();
    silentSinceRef.current = null;
    speechDetectedRef.current = false;
    stoppingRef.current = false;
    updateState('idle');
  }, [updateState, clearAmplitudeTimer]);

  // ── Assign startListening implementation ──
  // Uses refs for stopListeningInternal to avoid circular deps.
  useEffect(() => {
    startListeningRef.current = async () => {
      if (!mountedRef.current) return;
      try {
        setErrorMessage(null);
        silentSinceRef.current = null;
        speechDetectedRef.current = false;
        stoppingRef.current = false;
        recordStartRef.current = Date.now();

        const recorder = Platform.OS === 'web'
          ? createWebRecorder()
          : await createNativeRecorder();

        // If conversation was ended while we were creating the recorder, abort
        if (!mountedRef.current || (!conversationActiveRef.current && voiceState === 'idle')) {
          recorder.cleanup();
          return;
        }

        recorderRef.current = recorder;
        await recorder.start();
        updateState('listening');

        amplitudeTimerRef.current = setInterval(async () => {
          if (!mountedRef.current) return;

          const amp = await recorder.getAmplitude();
          setAmplitude(amp);

          // VAD only when conversation loop is active
          if (!conversationActiveRef.current) return;
          if (Date.now() - recordStartRef.current < MIN_RECORD_DURATION) return;

          if (amp > silenceThreshold) {
            speechDetectedRef.current = true;
            silentSinceRef.current = null;
          } else if (speechDetectedRef.current) {
            if (silentSinceRef.current === null) {
              silentSinceRef.current = Date.now();
            } else if (Date.now() - silentSinceRef.current >= silenceTimeout) {
              if (!stoppingRef.current) {
                stoppingRef.current = true;
                if (amplitudeTimerRef.current) {
                  clearInterval(amplitudeTimerRef.current);
                  amplitudeTimerRef.current = null;
                }
                // Call via ref to get latest implementation
                setTimeout(() => stopListeningInternalRef.current(), 0);
              }
            }
          }
        }, 100);
      } catch (err: any) {
        console.error('[voice] Recording start failed:', err?.message);
        setErrorMessage('Microphone access denied. Please enable it in settings.');
        updateState('error');
        if (conversationActiveRef.current) {
          conversationActiveRef.current = false;
          setConversationActive(false);
        }
      }
    };
  }, [updateState, silenceThreshold, silenceTimeout]);

  // ── Assign stopListeningInternal implementation ──
  useEffect(() => {
    stopListeningInternalRef.current = async () => {
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
          setTimeout(() => {
            if (mountedRef.current && conversationActiveRef.current) {
              startListeningRef.current();
            } else if (mountedRef.current) {
              updateState('idle');
            }
          }, 1500);
          return;
        }

        // We have text — transition to thinking and send to chat
        updateState('thinking');
        onTranscriptRef.current(data.text);
      } catch (err: any) {
        console.error('[voice] Transcription failed:', err?.message);
        setErrorMessage('Failed to process audio');
        updateState('error');
        setTimeout(() => {
          if (mountedRef.current && conversationActiveRef.current) {
            startListeningRef.current();
          } else if (mountedRef.current) {
            updateState('idle');
          }
        }, 2000);
      }
    };
  }, [updateState]);

  // ── Public API (stable references that delegate to refs) ──

  const startListening = useCallback(async () => {
    await startListeningRef.current();
  }, []);

  const stopListening = useCallback(async () => {
    stoppingRef.current = true;
    await stopListeningInternalRef.current();
  }, []);

  const toggleListening = useCallback(async () => {
    if (conversationActiveRef.current) {
      endConversation();
      return;
    }

    conversationActiveRef.current = true;
    setConversationActive(true);
    await startListeningRef.current();
  }, [endConversation]);

  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (!mountedRef.current) return;

    try {
      updateState('speaking');
      const token = await getToken();

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
        if (mountedRef.current && conversationActiveRef.current) {
          await startListeningRef.current();
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
        if (conversationActiveRef.current) {
          startListeningRef.current();
        } else {
          updateState('idle');
        }
      });
    } catch (err: any) {
      console.warn('[voice] TTS playback error:', err?.message);
      if (mountedRef.current && conversationActiveRef.current) {
        startListeningRef.current();
      } else if (mountedRef.current) {
        updateState('idle');
      }
    }
  }, [updateState]);

  const stopSpeaking = useCallback(() => {
    playerRef.current.stop();
    if (conversationActiveRef.current) {
      startListeningRef.current();
    } else {
      updateState('idle');
    }
  }, [updateState]);

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
