import type { Preferences, VideoQuality } from '../config';

export interface DeviceLists {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

const RESOLUTIONS: Record<VideoQuality, { width: number; height: number }> = {
  '360p': { width: 640, height: 360 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

export function audioConstraints(prefs: Preferences): MediaTrackConstraints {
  return {
    ...(prefs.audioInput ? { deviceId: { exact: prefs.audioInput } } : {}),
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: prefs.autoGainControl,
  };
}

export function videoConstraints(prefs: Preferences): MediaTrackConstraints {
  const { width, height } = RESOLUTIONS[prefs.videoQuality] ?? RESOLUTIONS['720p'];
  return {
    ...(prefs.videoInput ? { deviceId: { exact: prefs.videoInput } } : {}),
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: 30, max: 30 },
  };
}

/** Turns getUserMedia errors into something a user can act on. */
export function describeMediaError(error: unknown, kind: 'microphone' | 'camera' | 'microphone and camera'): string {
  const name = (error as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Access to the ${kind} was blocked. Allow it in the browser's site settings and try again.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${kind} found. Connect one or pick another device in Settings.`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${kind} is in use by another application or could not be started.`;
    default:
      return `Could not access the ${kind}${error instanceof Error && error.message ? `: ${error.message}` : '.'}`;
  }
}

async function getUserMediaWithFallback(constraints: MediaStreamConstraints): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    // A remembered device may have been unplugged: retry with the default one.
    if ((error as { name?: string }).name === 'OverconstrainedError' || (error as { name?: string }).name === 'NotFoundError') {
      const relaxed: MediaStreamConstraints = {};
      for (const kind of ['audio', 'video'] as const) {
        const c = constraints[kind];
        if (c && typeof c === 'object' && 'deviceId' in c) {
          const { deviceId: _ignored, ...rest } = c;
          relaxed[kind] = rest;
        } else {
          relaxed[kind] = c;
        }
      }
      return navigator.mediaDevices.getUserMedia(relaxed);
    }
    throw error;
  }
}

export interface LocalMedia {
  stream: MediaStream;
  /** Video was requested but could not be captured (no camera, blocked, busy). */
  videoError?: string;
}

/**
 * Captures the microphone (and the camera when `video` is true). When the camera
 * fails the call can still go ahead audio-only, so that is reported instead of thrown.
 */
export async function getLocalMedia(prefs: Preferences, video: boolean): Promise<LocalMedia> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access the microphone (a secure HTTPS page is required).');
  }
  if (video) {
    try {
      return {
        stream: await getUserMediaWithFallback({ audio: audioConstraints(prefs), video: videoConstraints(prefs) }),
      };
    } catch (error) {
      // Possibly only the camera is missing/blocked/busy: fall back to the microphone alone.
      try {
        const stream = await getUserMediaWithFallback({ audio: audioConstraints(prefs) });
        return { stream, videoError: describeMediaError(error, 'camera') };
      } catch (audioError) {
        throw new Error(describeMediaError(audioError, 'microphone'));
      }
    }
  }
  try {
    return { stream: await getUserMediaWithFallback({ audio: audioConstraints(prefs) }) };
  } catch (error) {
    throw new Error(describeMediaError(error, 'microphone'));
  }
}

export async function getCameraTrack(prefs: Preferences): Promise<MediaStreamTrack> {
  try {
    const stream = await getUserMediaWithFallback({ video: videoConstraints(prefs) });
    return stream.getVideoTracks()[0]!;
  } catch (error) {
    throw new Error(describeMediaError(error, 'camera'));
  }
}

export async function listDevices(): Promise<DeviceLists> {
  const devices = navigator.mediaDevices?.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
  return {
    audioInputs: devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications'),
    videoInputs: devices.filter((d) => d.kind === 'videoinput'),
    audioOutputs: devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications'),
  };
}

export function supportsOutputSelection(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export async function applyOutputDevice(element: HTMLMediaElement, deviceId: string): Promise<void> {
  if (!supportsOutputSelection()) return;
  const el = element as HTMLMediaElement & { setSinkId(id: string): Promise<void>; sinkId?: string };
  if (el.sinkId === deviceId) return;
  try {
    await el.setSinkId(deviceId);
  } catch (error) {
    console.warn('setSinkId failed, using the default output', error);
  }
}

/** A black video track, used to keep a send-capable video line when answering with the camera off. */
export function createPlaceholderVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas.captureStream(1).getVideoTracks()[0]!;
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
