/**
 * The tone played when a new alert arrives.
 *
 * Synthesised with the Web Audio API instead of shipping an audio file: no asset to host, cache or
 * license, and the pitch and length are constants rather than a binary nobody can review.
 *
 * Browsers refuse to start audio until the user has interacted with the page. That is expected on
 * a dashboard left open untouched, so a refused tone is swallowed - the badge still updates, and
 * the first click anywhere unlocks sound for every later alert.
 */

const TONE_FREQUENCIES_HZ = [880, 1174.66] as const;
const NOTE_DURATION_S = 0.16;
const NOTE_GAP_S = 0.04;
const PEAK_GAIN = 0.18;
const ATTACK_S = 0.01;
const SILENT_GAIN = 0.0001;

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  context = new Ctor();
  return context;
}

export async function playAlertTone(): Promise<void> {
  try {
    const audio = getContext();
    if (!audio) return;

    if (audio.state === 'suspended') await audio.resume();
    if (audio.state !== 'running') return;

    let startAt = audio.currentTime;
    for (const frequency of TONE_FREQUENCIES_HZ) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      // Ramped rather than switched, or each note starts and ends with an audible click.
      gain.gain.setValueAtTime(SILENT_GAIN, startAt);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, startAt + NOTE_DURATION_S);

      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + NOTE_DURATION_S);
      // Nodes are released with the oscillator's end; disconnect so the graph does not retain them.
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };

      startAt += NOTE_DURATION_S + NOTE_GAP_S;
    }
  } catch (error) {
    console.warn('alert tone could not be played:', error);
  }
}
