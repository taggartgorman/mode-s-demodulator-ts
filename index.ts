// @ts-ignore
import msgLen from 'mode-s-msglen';
// @ts-ignore
import Decoder from 'mode-s-decoder';

const PREAMBLE_US = 8; // microseconds
const FULL_LEN = PREAMBLE_US + msgLen.LONG_MSG_BITS;

export type DemodulatorOptions = {
	aggressive?: boolean           // Set to true to use an aggressive error correction algorithm.
	checkCrc?: boolean             // Set to false to disable checksum validation.
	crcOnly?: boolean              // Set to true to only validate the checksum of the Mode S messages without trying to decode them any further than necessary in order to validate the checksum.
	mag?: Uint16Array | null       // An optional pre-initialized magnitude Uint16Array used by the process function. If not provided it's expected that process will always be called with the same amount of data.
}

// The Message object actually comes from the mode-s-decoder library, but no typing exists for
// that library, so I have included the type here.
export type Message = {
	// Generic fields
	msg: any                       // Binary message
	msgbits: number                // Number of bits in message
	msgtype: number                // Downlink format #
	crcOk: boolean                 // True if CRC was valid
	crc: number                    // Message CRC
	errorbit: number               // Bit corrected. -1 if no bit corrected.
	icao: number                   // ICAO address in decimal form
	phaseCorrected: boolean        // True if phase correction was applied.

	// DF 11
	ca: number                     // Responder capabilities.

	// DF 17
	metype: number                 // Extended squitter message type.
	mesub: number                  // Extended squitter message subtype.
	headingIsValid: boolean
	heading: number
	aircraftType: number
	fflag: number                  // 1 = Odd, 0 = Even CPR message.
	tflag: number                  // UTC synchronized?
	rawLatitude: number            // Non decoded latitude
	rawLongitude: number           // Non decoded longitude
	callsign: string               // 8 chars flight number / callsign
	ewDir: number                  // 0 = East, 1 = West.
	ewVelocity: number             // E/W velocity.
	nsDir: number                  // 0 = North, 1 = South.
	nsVelocity: number             // N/S velocity.
	vertRateSource: number         // Vertical rate source.
	vertRateSign: number           // Vertical rate sign.
	vertRate: number               // Vertical rate.
	speed: number                  // Horizontal speed computed from EW and NS velocity.

	// DF4, DF5, DF20, DF21
	fs: number                     // Flight status for DF4,5,20,21
	dr: number                     // Request extraction of downlink request.
	um: number                     // Request extraction of downlink request.
	identity: number               // 13 bits identity (Squawk).

	// Fields used by multiple message types.
	altitude: number
	unit: number
}

export const UNIT_FEET = Decoder.UNIT_FEET;
export const UNIT_METERS = Decoder.UNIT_METERS;

export class Demodulator {
	private options: DemodulatorOptions;

	private decoder; // Decoder from mode-s-decoder
	private MAG_LUT: Uint16Array;
	private _mag: Uint16Array | undefined;

	constructor(options?: DemodulatorOptions) {
		this.options = {
			aggressive: options?.aggressive !== false,
			checkCrc: options?.checkCrc || true,
			crcOnly: options?.crcOnly || false,
			mag: options?.mag || null
		}

		this.decoder = new Decoder(this.options);

		// Populate the I/Q -> Magnitude lookup table. It is used because sqrt or
		// round may be expensive and may vary a lot depending on the libc used.
		//
		// We scale to 0-255 range multiplying by 1.4 in order to ensure that every
		// different I/Q pair will result in a different magnitude value, not losing
		// any resolution.
		this.MAG_LUT = new Uint16Array(129 * 129 * 2);
		for (let i = 0; i <= 128; i++) {
			for (let q = 0; q <= 128; q++) {
				this.MAG_LUT[i * 129 + q] = Math.round(Math.sqrt(i * i + q * q) * 360);
			}
		}
	}

	public process(data: Buffer, size: number, onMsg: (message: Message) => void) {
		// If no pre-initialized magnitute array have been given upon initialization,
		// initialize one the first time `process` is called with the expectation
		// that all subsequent calls will not contain data of a larger size than the
		// first call
		if (!this._mag) {
			this._mag = new Uint16Array(size / 2);
		}

		this.computeMagnitudeVector(data, this._mag, size);
		this.detectMessage(this._mag, size / 2, onMsg);
	}

	// Turn I/Q samples pointed by `data` into the magnitude vector pointed by `mag`
	public computeMagnitudeVector(data: Buffer, mag: Uint16Array, size: number, signedInt: boolean = false) {
		// Compute the magnitude vector. It's just SQRT(I^2 + Q^2), but we rescale
		// to the 0-255 range to exploit the full resolution.
		if (signedInt) {
			for (let j = 0; j < size; j += 2) {
				let i = data.readInt8(j);
				let q = data.readInt8(j + 1);

				if (i < 0) {
					i = -i;
				}
				if (q < 0) {
					q = -q;
				}

				mag[j / 2] = this.MAG_LUT[i * 129 + q];
			}
		} else {
			for (let j = 0; j < size; j += 2) {
				let i = data[j] - 127;
				let q = data[j + 1] - 127;

				if (i < 0) {
					i = -i;
				}
				if (q < 0) {
					q = -q;
				}
				mag[j / 2] = this.MAG_LUT[i * 129 + q];
			}
		}
	}

	public detectMessage(mag: Uint16Array, maglen: number, onMsg: (message: Message) => void) {
		const bits = new Uint8Array(msgLen.LONG_MSG_BITS);
		const msg = new Uint8Array(msgLen.LONG_MSG_BITS / 2);
		const aux = new Uint16Array(msgLen.LONG_MSG_BITS * 2);
		let useCorrection = false;

		// The Mode S preamble is made of impulses of 0.5 microseconds at the
		// following time offsets:
		//
		// 0   - 0.5 usec: first impulse.
		// 1.0 - 1.5 usec: second impulse.
		// 3.5 - 4   usec: third impulse.
		// 4.5 - 5   usec: last impulse.
		//
		// Since we are sampling at 2 Mhz every sample in our magnitude vector is
		// 0.5 usec, so the preamble will look like this, assuming there is an
		// impulse at offset 0 in the array:
		//
		// 0   -----------------
		// 1   -
		// 2   ------------------
		// 3   --
		// 4   -
		// 5   --
		// 6   -
		// 7   ------------------
		// 8   --
		// 9   -------------------
		for (let j = 0; j < maglen - FULL_LEN * 2; j++) {
			let low: number, high: number, delta: number, i: number, errors: number;
			let goodMessage = false;

			if (useCorrection) {
				// If the previous attempt with this message failed, retry using
				// magnitude correction.
				memcpy(aux, 0, mag, j + PREAMBLE_US * 2, aux.length)
				if (j && detectOutOfPhase(mag, j)) {
					applyPhaseCorrection(mag, j);
				}
				// TODO ... apply other kind of corrections.
			} else {
				// First check of relations between the first 10 samples representing a
				// valid preamble. We don't even investigate further if this simple
				// test is not passed.
				if (!(mag[j] > mag[j + 1] &&
					mag[j + 1] < mag[j + 2] &&
					mag[j + 2] > mag[j + 3] &&
					mag[j + 3] < mag[j] &&
					mag[j + 4] < mag[j] &&
					mag[j + 5] < mag[j] &&
					mag[j + 6] < mag[j] &&
					mag[j + 7] > mag[j + 8] &&
					mag[j + 8] < mag[j + 9] &&
					mag[j + 9] > mag[j + 6])) {
					continue;
				}

				// The samples between the two spikes must be < than the average of the
				// high spikes level. We don't test bits too near to the high levels as
				// signals can be out of phase so part of the energy can be in the near
				// samples.
				high = (mag[j] + mag[j + 2] + mag[j + 7] + mag[j + 9]) / 6;
				if (mag[j + 4] >= high ||
					mag[j + 5] >= high) {
					continue;
				}

				// Similarly samples in the range 11-14 must be low, as it is the space
				// between the preamble and real data. Again we don't test bits too
				// near to high levels, see above.
				if (mag[j + 11] >= high ||
					mag[j + 12] >= high ||
					mag[j + 13] >= high ||
					mag[j + 14] >= high) {
					continue;
				}
			}

			// Decode all the next 112 bits, regardless of the actual message size.
			// We'll check the actual message type later.
			errors = 0;
			for (i = 0; i < msgLen.LONG_MSG_BITS * 2; i += 2) {
				low = mag[j + i + PREAMBLE_US * 2];
				high = mag[j + i + PREAMBLE_US * 2 + 1];
				delta = low - high;
				if (delta < 0) {
					delta = -delta;
				}

				if (i > 0 && delta < 256) {
					bits[i / 2] = bits[i / 2 - 1];
				} else if (low === high) {
					// Checking if two adiacent samples have the same magnitude is
					// an effective way to detect if it's just random noise that
					// was detected as a valid preamble.
					bits[i / 2] = 2; // error
					if (i < msgLen.SHORT_MSG_BITS * 2) {
						errors++;
					}
				} else if (low > high) {
					bits[i / 2] = 1;
				} else {
					// (low < high) for exclusion
					bits[i / 2] = 0;
				}
			}

			// Restore the original message if we used magnitude correction.
			if (useCorrection) {
				memcpy(mag, j + PREAMBLE_US * 2, aux, 0, aux.length);
			}

			// Pack bits into bytes
			for (i = 0; i < msgLen.LONG_MSG_BITS; i += 8) {
				msg[i / 8] =
					bits[i] << 7 |
					bits[i + 1] << 6 |
					bits[i + 2] << 5 |
					bits[i + 3] << 4 |
					bits[i + 4] << 3 |
					bits[i + 5] << 2 |
					bits[i + 6] << 1 |
					bits[i + 7];
			}

			const msgtype = msg[0] >> 3;
			const msglen = msgLen(msgtype) / 8;

			// Last check, high and low bits are different enough in magnitude to
			// mark this as real message and not just noise?
			delta = 0;
			for (i = 0; i < msglen * 8 * 2; i += 2) {
				delta += Math.abs(mag[j + i + PREAMBLE_US * 2] -
					mag[j + i + PREAMBLE_US * 2 + 1]);
			}
			delta /= msglen * 4;

			// Filter for an average delta of three is small enough to let almost
			// every kind of message to pass, but high enough to filter some random
			// noise.
			if (delta < 10 * 255) {
				useCorrection = false;
				continue;
			}

			// If we reached this point, and error is zero, we are very likely with
			// a Mode S message in our hands, but it may still be broken and CRC
			// may not be correct. This is handled by the next layer.
			if (errors === 0 || (this.options.aggressive && errors < 3)) {
				// Parse the received message
				const mm = this.decoder.parse(msg, this.options.crcOnly);

				// Stop trying to apply error correction to message decoding if we
				// successfully validated the checksum
				if (mm.crcOk) {
					j += (PREAMBLE_US + (msglen * 8)) * 2;
					goodMessage = true;
					if (useCorrection) {
						mm.phaseCorrected = true;
					}
				}

				// FIXME: If bad CRC, but checkCrc is false, will this logic then
				// not both call onMsg with the bad message AND try to
				// error-correct it, in which case we might end up calling onMsg
				// again with the error corrected message?
				if (mm.crcOk || !this.options.checkCrc) {
					onMsg(mm);
				}
			}

			// Retry with phase correction if possible.
			if (!goodMessage && !useCorrection) {
				j--
				useCorrection = true
			} else {
				useCorrection = false
			}
		}
	}
}

// Return -1 if the message is out of fase left-side
// Return  1 if the message is out of fase right-size
// Return  0 if the message is not particularly out of phase.
//
// Note: this function will access mag[-1], so the caller should make sure to
// call it only if we are not at the start of the current buffer.
function detectOutOfPhase(mag: Uint16Array, offset: number): number {
	if (mag[offset + 3] > mag[offset + 2] / 3) {
		return 1;
	}
	if (mag[offset + 10] > mag[offset + 9] / 3) {
		return 1;
	}
	if (mag[offset + 6] > mag[offset + 7] / 3) {
		return -1;
	}
	if (mag[offset + -1] > mag[offset + 1] / 3) {
		return -1;
	}
	return 0;
}

// This function does not really correct the phase of the message, it just
// applies a transformation to the first sample representing a given bit:
//
// If the previous bit was one, we amplify it a bit.
// If the previous bit was zero, we decrease it a bit.
//
// This simple transformation makes the message a bit more likely to be
// correctly decoded for out of phase messages:
//
// When messages are out of phase there is more uncertainty in sequences of the
// same bit multiple times, since 11111 will be transmitted as continuously
// altering magnitude (high, low, high, low...)
//
// However because the message is out of phase some part of the high is mixed
// in the low part, so that it is hard to distinguish if it is a zero or a one.
//
// However when the message is out of phase passing from 0 to 1 or from 1 to 0
// happens in a very recognizable way, for instance in the 0 -> 1 transition,
// magnitude goes low, high, high, low, and one of of the two middle samples
// the high will be *very* high as part of the previous or next high signal
// will be mixed there.
//
// Applying our simple transformation we make more likely if the current bit is
// a zero, to detect another zero. Symmetrically if it is a one it will be more
// likely to detect a one because of the transformation. In this way similar
// levels will be interpreted more likely in the correct way.
function applyPhaseCorrection(mag: Uint16Array, offset: number) {
	// Move ahead 16 to skip preamble.
	for (let j = 16; j < (msgLen.LONG_MSG_BITS - 1) * 2; j += 2) {
		if (mag[offset + j] > mag[offset + j + 1]) {
			// One
			mag[offset + j + 2] = (mag[offset + j + 2] * 5) / 4;
		} else {
			// Zero
			mag[offset + j + 2] = (mag[offset + j + 2] * 4) / 5;
		}
	}
}

function memcpy(dst: Uint16Array, dstOffset: number, src: Uint16Array, srcOffset: number, length: number) {
	for (let i = srcOffset; i < length; i++) {
		dst[dstOffset + i] = src[i];
	}
}
