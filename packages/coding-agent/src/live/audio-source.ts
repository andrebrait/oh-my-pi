import { AudioCapture } from "@oh-my-pi/pi-natives";

/** Handlers a live audio source reports to its owner. */
export interface LiveAudioSourceHandlers {
	/** Reports one 16 kHz mono Float32 PCM chunk captured from the user. */
	onAudio(samples: Float32Array): void;
	/** Reports a source failure that should terminate the live session. */
	onError(error: Error): void;
}

/** Producer of microphone audio for a live session. */
export interface LiveAudioSource {
	/** Starts producing audio chunks. Called once per live session. */
	start(handlers: LiveAudioSourceHandlers): void;
	/** Stops producing audio; safe to call repeatedly. */
	stop(): void;
}

/** Default source backed by the native microphone capture. */
export class NativeLiveAudioSource implements LiveAudioSource {
	#capture: AudioCapture | undefined;

	start(handlers: LiveAudioSourceHandlers): void {
		this.#capture = new AudioCapture(16_000, (error, samples) => {
			if (error) {
				handlers.onError(error);
				return;
			}
			handlers.onAudio(samples);
		});
	}

	stop(): void {
		const capture = this.#capture;
		this.#capture = undefined;
		if (capture) {
			try {
				capture.stop();
			} catch (cause) {
				throw cause instanceof Error ? cause : new Error(String(cause));
			}
		}
	}
}

/**
 * Source fed by a remote client (for example a browser) instead of the local
 * microphone. The owner pushes already-resampled 16 kHz mono Float32 PCM
 * chunks through {@link feed}.
 */
export class RemoteLiveAudioSource implements LiveAudioSource {
	#handlers: LiveAudioSourceHandlers | undefined;

	start(handlers: LiveAudioSourceHandlers): void {
		this.#handlers = handlers;
	}

	stop(): void {
		this.#handlers = undefined;
	}

	/** Delivers one remote audio chunk to the live session. */
	feed(samples: Float32Array): void {
		this.#handlers?.onAudio(samples);
	}

	/** Reports a remote client failure to the live session. */
	reportError(error: Error): void {
		this.#handlers?.onError(error);
	}
}

/** Converts little-endian Int16 PCM bytes to mono Float32 samples. */
export function int16ToFloat32(bytes: Int8Array | Uint8Array | Buffer): Float32Array {
	const whole = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
	const samples = new Float32Array(whole.length);
	for (let index = 0; index < whole.length; index += 1) {
		samples[index] = (whole[index] ?? 0) / 32_768;
	}
	return samples;
}

/** Converts mono Float32 samples to little-endian Int16 PCM bytes. */
export function float32ToInt16(samples: Float32Array): Buffer {
	const buffer = Buffer.alloc(samples.length * 2);
	for (let index = 0; index < samples.length; index += 1) {
		const scaled = Math.max(-1, Math.min(1, samples[index] ?? 0));
		buffer.writeInt16LE(Math.round(scaled * 32_767), index * 2);
	}
	return buffer;
}
