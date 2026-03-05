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
 * - Single tap to start, tap again to stop + transcribe (or exit loop)
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
  onTranscript: (text: string) => void;
  onStateChange?: (state: VoiceState) => void;
  autoPlayResponse?: boolean;
  silenceTimeout?: number;
  silenceThreshold?: number;
}

interface UseVoiceConversationReturn {
  voiceState: VoiceState;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  toggleListening: () => Promise<void>;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  isSupported: boolean;
  errorMessage: string | null;
  amplitude: number;
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

export function useVoiceConversation({
  onTranscript,
  onStateChange,
  autoPlayResponse = true,
  silenceTimeout = 1500,
  silenceThreshold = 0.08,
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
  const voiceStateRef = useRef<VoiceState>('idle');

  // Keep callback props in refs to avoid stale closures
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  const MIN_RECORD_DURATION = 600;

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
    voiceStateRef.current = state;
    setVoiceState(state);
    onStateChangeRef.current?.(state);
  }, []);

  const getToken = async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || null;
  };

  const clearAmplitudeTimer = useCallback(() => {
    if (amplitudeTimerRef.current) {
      clearInterval(amplitudeTimerRef.current);
      amplitudeTimerRef.current = null;
    }
    setAmplitude(0);
  }, []);

  // ── Core: stop recording + transcribe ──
  // This is the single function that handles stopping a recording and sending
  // it to STT. It does NOT end the conversation loop — the loop continues
  // (or not) based on conversationActiveRef.
  const processRecording = useCallback(async () => {
    clearAmplitudeTimer();
    silentSinceRef.current = null;
    stoppingRef.current = false;

    const recorder = recorderRef.current;
    if (!recorder) {
      // No recorder to process — go idle
      if (voiceStateRef.current === 'listening') updateState('idle');
      return;
    }
    recorderRef.current = null;

    try {
      updateState('processing');
      const { base64, mimeType } = await recorder.stop();

      const token = await getToken();
      if (!token) {
        setErrorMessage('Not authenticated');
        updateState('error');
        setTimeout(() => { if (mountedRef.current) updateState('idle'); }, 2000);
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
          if (!mountedRef.current) return;
          if (conversationActiveRef.current) {
            // Conversation loop: retry listening
            startRecording();
          } else {
            updateState('idle');
          }
        }, 1500);
        return;
      }

      // Success — send to chat
      updateState('thinking');
      onTranscriptRef.current(data.text);
    } catch (err: any) {
      console.error('[voice] Transcription failed:', err?.message);
      setErrorMessage('Failed to process audio');
      updateState('error');
      setTimeout(() => {
        if (!mountedRef.current) return;
        if (conversationActiveRef.current) {
          startRecording();
        } else {
          updateState('idle');
        }
      }, 2000);
    }
  }, [updateState, clearAmplitudeTimer]);

  // ── Core: start recording ──
  // Separated so it can be called from multiple places without circular deps.
  // Uses processRecording ref to avoid stale closure.
  const processRecordingRef = useRef(processRecording);
  processRecordingRef.current = processRecording;

  const startRecording = useCallback(async () => {
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

      // Check if we were cancelled while creating recorder
      if (!mountedRef.current) {
        recorder.cleanup();
        return;
      }

      recorderRef.current = recorder;
      await recorder.start();
      updateState('listening');

      // Amplitude polling + VAD
      amplitudeTimerRef.current = setInterval(async () => {
        if (!mountedRef.current) return;

        const amp = await recorder.getAmplitude();
        setAmplitude(amp);

        // VAD: only auto-stop in conversation mode
        if (!conversationActiveRef.current) return;
        if (stoppingRef.current) return;
        if (Date.now() - recordStartRef.current < MIN_RECORD_DURATION) return;

        if (amp > silenceThreshold) {
          speechDetectedRef.current = true;
          silentSinceRef.current = null;
        } else if (speechDetectedRef.current) {
          // Speech was detected, now it's silent
          if (silentSinceRef.current === null) {
            silentSinceRef.current = Date.now();
          } else if (Date.now() - silentSinceRef.current >= silenceTimeout) {
            // Silence long enough — auto-stop and transcribe
            stoppingRef.current = true;
            if (amplitudeTimerRef.current) {
              clearInterval(amplitudeTimerRef.current);
              amplitudeTimerRef.current = null;
            }
            setTimeout(() => processRecordingRef.current(), 0);
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
  }, [updateState, silenceThreshold, silenceTimeout]);

  // Keep the ref up to date (startRecording changes when deps change)
  const startRecordingRef = useRef(startRecording);
  startRecordingRef.current = startRecording;

  // ── Hard cancel: discard recording and end loop ──
  const endConversation = useCallback(() => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    clearAmplitudeTimer();
    stoppingRef.current = false;
    silentSinceRef.current = null;
    speechDetectedRef.current = false;
    // Discard any in-progress recording
    if (recorderRef.current) {
      recorderRef.current.cleanup();
      recorderRef.current = null;
    }
    playerRef.current.stop();
    updateState('idle');
  }, [updateState, clearAmplitudeTimer]);

  // ── Public: start listening ──
  const startListening = useCallback(async () => {
    await startRecording();
  }, [startRecording]);

  // ── Public: stop listening (stop + transcribe) ──
  const stopListening = useCallback(async () => {
    stoppingRef.current = true;
    await processRecording();
  }, [processRecording]);

  // ── Public: toggle ──
  // First tap: start conversation loop + begin recording
  // Second tap while listening: stop recording + transcribe + end loop
  // Second tap while processing/thinking/speaking: hard cancel
  const toggleListening = useCallback(async () => {
    if (conversationActiveRef.current) {
      const state = voiceStateRef.current;
      if (state === 'listening') {
        // User tapped while recording — stop, transcribe, then end loop after this turn
        conversationActiveRef.current = false;
        setConversationActive(false);
        stoppingRef.current = true;
        await processRecordingRef.current();
      } else {
        // User tapped during processing/thinking/speaking — hard cancel
        endConversation();
      }
      return;
    }

    // Start conversation loop
    conversationActiveRef.current = true;
    setConversationActive(true);
    await startRecordingRef.current();
  }, [endConversation]);

  // ── Speak response via TTS, then auto-listen if loop active ──
  const speak = useCallback(async (text: string) => {
    if (!text.trim() || !mountedRef.current) return;

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
          await startRecordingRef.current();
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
          startRecordingRef.current();
        } else {
          updateState('idle');
        }
      });
    } catch (err: any) {
      console.warn('[voice] TTS playback error:', err?.message);
      if (mountedRef.current && conversationActiveRef.current) {
        startRecordingRef.current();
      } else if (mountedRef.current) {
        updateState('idle');
      }
    }
  }, [updateState]);

  // ── Stop speaking ──
  const stopSpeaking = useCallback(() => {
    playerRef.current.stop();
    if (conversationActiveRef.current) {
      startRecordingRef.current();
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
