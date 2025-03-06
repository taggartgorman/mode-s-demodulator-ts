# mode-s-demodulator

A TypeScript module for demodulating and decoding Mode S / ADS-B
messages from aviation aircrafts. I wrapped Thomas Watson's JavaScript library
[mode-s-demodulator](https://www.npmjs.com/package/mode-s-demodulator) with
appropriate types and updated the library to be a CommonJS module.

Mode S is an aviation transponder interrogation mode used by Secondary
Surveillance Radar (SSR) and Automatic Dependent Surveillance-Broadcast
(ADS-B) systems.

## Installation

```
npm install mode-s-demodulator-ts --save
```

## Usage

```ts
include { Demodulator, Message } from 'mode-s-demodulator-ts';

const demodulator = new Demodulator()

// data contains raw IQ samples from an RTL-SDR device
demodulator.process(data, data.length, function (message: Message) {
  // got new Mode S message from an airplane
  console.log(message)
})
```

Tip: Use together with the [rtl-sdr](https://github.com/watson/rtl-sdr)
module to get raw IQ samples that can be processed by this module.

## API

### `UNIT_FEET`

A constant indicating that the unit used to encode `message.altitude` is
feet. Check against `message.unit`.

`message` is an object given as the first argument to the
`demodulator.process` or `demodulator.detectMessage` callback.

### `UNIT_METERS`

A constant indicating that the unit used to encode `message.altitude` is
meters. Check against `message.unit`.

`message` is an object given as the first argument to the
`demodulator.process` or `demodulator.detectMessage` callback.

### `demodulator = new Demodulator(options?: DemodulatorOptions)`

Initialize a new demodulator object.

Arguments:

- `options` - An optional options object

The available options are:

- `aggressive` - Set to `true` to use an aggressive error correction
  algorithm (default: `false`)
- `checkCrc` - Set to `false` to disable checksum validation (default:
  `true`)
- `crcOnly` - Set to `true` to only validate the checksum of the Mode S
  messages without trying to decode them any further than necessary in
  order to validate the checksum (default: `false`)
- `mag` - An optional pre-initialized magnitude Uint16Array used by the
  `process` function. If not provided it's expected that `process` will
  always be called with the same amount of data

### `demodulator.process(data: Buffer, size: number, onMsg: (message: Message) => void)`

A convenience function that takes care of everything related to
processing the provided `data`.

It handles initializing a magnitute array (if not provided to the
`Demodulator` constructor) and calling `computeMagnitudeVector` and
`detectMessage` respectively.

Arguments:

- `data` - A buffer object containing raw IQ samples
- `size` - The size of the `data` buffer
- `onMsg` - Called for each new message detected in `data`. Will be called
  with the message as the only argument.

### `demodulator.computeMagnitudeVector(data: Buffer, mag: Uint16Array, size: number, signedInt: boolean = false)`

Calculate the magnitude of each sample in the signal.

Arguments:

- `data` - A buffer object containing raw IQ samples
- `mag` - An `Uint16Array` to which the magnitude of each sample will be
  written. Since each IQ sample in `data` consists of two bytes, the
  array should be at least half the size of the `data` buffer
- `size` - The size of the `data` buffer
- `signedInt` - Optional boolean indicating if the IQ samples are
  encoded as signed integers (default: `false`)

### `demodulator.detectMessage(mag: Uint16Array, maglen: number, onMsg: (message: Message) => void)`

Detect Mode S messages in the magnitute array.

Arguments:

- `mag` - The `mag` array computed using `computeMagnitudeVector()`
- `size` - The size of the `mag` array
- `onMsg` - Called for each new message detected in `mag`. Will be
  called with the message as the only argument.

## Acknowledgement

This project is a TypeScript port of the JavaScript port of the popular
[dump1090](https://github.com/antirez/dump1090) project by Salvatore
Sanfilippo. It modularizes the code into separate functions and removes
all non-essentials, so that only the demodulation and decoding logic is
left.

## License

MIT
