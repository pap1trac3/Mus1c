# SomaticPulse

A psychoacoustic resonance plug-in: a binaural sub-oscillator, a somatic pulse
LFO, a Solfeggio resonator with micro-detune, a phase-safe output stage, a
bounded session clock and a band-limited tactile transducer send — designed to
sit under musical stems without muddying the low end or collapsing on a mono
system.

**Scope.** This is an audio plug-in. It produces sound and, through a second
output bus, signal for a tactile transducer. It is not a medical device, it
does not deliver clinical acoustic or shockwave therapy, and nothing here
treats anything. Clinical devices in that space apply mechanical energy
directly to tissue at ultrasonic frequencies through a handheld applicator; a
VST3 is capped at half the session sample rate and cannot do that, so no
feature here attempts to imitate one.

- **Formats:** VST3, Standalone, and AU on macOS
- **Framework:** JUCE 8.0.15, C++20, CMake
- **Real-time safety:** no allocation, no locks and no blocking calls in
  `processBlock`; every audible parameter runs through a 20 ms
  `juce::SmoothedValue` ramp.

## What is in it

| Stage | What it does |
| --- | --- |
| **Binaural core** | Two `double`-precision carriers split symmetrically around the centre frequency. Three beat modes: **Binaural** (a different tone per ear, neural, headphones only), **Monaural** (both carriers in both channels, so the beat is real amplitude modulation in every channel) and **Isochronic** (one carrier gated on and off, the strongest option through a transducer). |
| **Somatic pulse** | Free or tempo-synced LFO, four shapes including a cardiac "Double-Thump". The rate reaches down to **0.05 Hz**, so breath pacing is in range: the display switches to cycles per minute below 1 Hz. |
| **Resonator** | Up to four parallel zero-delay bandpasses on a base frequency and its harmonics, plus a crossfaded fractional-delay micro-detune for concert-pitch shifts. |
| **Phase-safe output** | Envelope-follower ducking, an LR4 mono-maker, a 5 Hz DC blocker and a soft ceiling. |
| **Session clock** | A bounded session with a fade in, a hold and a fade out, scaling the generated and processed content only. Optional ramp of the beat and pulse rates across the session. |
| **Tactile send** | A second output bus, band-passed into the transducer's usable range, with its own level and an audio-plus-tactile or tactile-only routing. |
| **Metering** | A vectorscope with a correlation readout, peak, and K-weighted momentary loudness with a session maximum. |

### Beat modes, precisely

A binaural beat is produced neurally from two tones presented separately, one
per ear. Each channel on its own carries no amplitude modulation at all, which
is why a single transducer handed one of those channels reproduces no pulse.

Summing the two carriers does not cancel the beat — two tones a few hertz
apart added together beat acoustically at the difference frequency. What
summing removes is the dichotic presentation, so the effect stops being neural
and becomes ordinary amplitude modulation. If you are on speakers or driving a
transducer, Monaural or Isochronic puts that modulation in the signal
deliberately rather than relying on the artefact.

### Tactile output

Published usable ranges for home-theatre transducers run roughly 5–200 Hz
(ButtKicker BK-LFE 5–200 Hz, AuraSound AST-2B 20–80 Hz, Clark Synthesis
TST209 15–800 Hz), and their amplifiers low-pass between 40 and 160 Hz.
Content above that band does not become vibration; it becomes voice-coil heat.
The send is therefore a real band-pass, defaulting to 20–120 Hz.

The bus is **disabled by default** so hosts that cannot route a second output
still see an ordinary stereo effect. Enable it in the host's routing page; the
Tactile card shows whether the host has actually given the plug-in that bus.

### Session and pacing

`Session Length` of 0 means the clock is off and nothing fades. Above 0, the
generated layer fades in, holds, and fades out, then stops — the dry signal is
never touched, so a track does not fade out because the session did. Starting
the transport, locating backwards, or pressing **Restart** starts it again.

The pulse rate floor is 0.05 Hz (three cycles a minute). Resonance-frequency
breathing sits near 0.1 Hz — about six breaths a minute — with individual
rates between 4.5 and 7.0, and 5.5 the most common in HRV biofeedback. The
`Breath Pace 5.5/min` preset is set there.

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

JUCE is fetched automatically (tag `8.0.15`). To use a checkout you already
have, and skip the download:

```bash
cmake -S . -B build -DJUCE_DIR=/path/to/JUCE -DCMAKE_BUILD_TYPE=Release
```

Useful options:

| Option | Default | Meaning |
| --- | --- | --- |
| `SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD` | `ON` | Copy the built plug-in into the system VST3 / AU folder |
| `SOMATICPULSE_JUCE_TAG` | `8.0.15` | JUCE release used by `FetchContent` |
| `SOMATICPULSE_BUILD_TOOLS` | `OFF` | Also build the offline verification harness |

The plug-in has two output buses. The first is the ordinary stereo output; the
second, named **Tactile**, is disabled until the host enables it.

Artefacts land under `build/SomaticPulse_artefacts/Release/`.

### Linux build dependencies

```bash
sudo apt install libasound2-dev libfreetype6-dev libfontconfig1-dev \
                 libx11-dev libxext-dev libxinerama-dev libxrandr-dev \
                 libxcursor-dev libxcomposite-dev libgl1-mesa-dev
```

`JUCE_WEB_BROWSER=0` and `JUCE_USE_CURL=0` are set, so WebKit and GTK are not
needed.

## Prebuilt downloads

Every push builds the plug-in for Windows, macOS and Linux in GitHub Actions
and attaches it to the run. Open the repository's **Actions** tab, click the
most recent *Build plugin* run, and download the artifact for your platform
from the **Artifacts** section at the bottom:

| Artifact | Contains |
| --- | --- |
| `SomaticPulse-Windows-VST3` | `SomaticPulse.vst3` + standalone `.exe` |
| `SomaticPulse-macOS-VST3-AU` | `SomaticPulse.vst3`, `SomaticPulse.component`, standalone `.app` (universal, arm64 + x86_64) |
| `SomaticPulse-Linux-VST3` | `SomaticPulse.vst3` + standalone binary |

The builds are unsigned. On macOS, clear the download quarantine flag before
the plug-in will load:

```bash
xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/SomaticPulse.vst3
```

## Loading it in FL Studio

A plug-in binary is platform-specific: build on the machine you will run it on.
A `.vst3` built on Linux will not load in FL Studio on Windows or macOS.

1. Build on your own machine with the commands above. With
   `SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD=ON` the bundle is installed for you;
   otherwise copy `SomaticPulse.vst3` into
   `C:\Program Files\Common Files\VST3` (Windows) or
   `/Library/Audio/Plug-Ins/VST3` (macOS).
2. In FL Studio: **Options → Manage plugins → Find more plugins**. Add the
   folder if it is not already in the search list, then **Start scan**.
3. The plug-in appears under *Somatic Audio → SomaticPulse*, category
   *Fx / Modulation / Spatial*.
4. Drop it on a **mixer insert**, not the master, so it can duck against that
   track's own material. A send track works too — set *Dry/Wet* to 0 there so
   only the generated sub is added.

### A first pass that actually works

1. Start from **444Hz Somatic Sub Bed** and solo the track.
2. Set *Carrier* to a sub-octave of the key you are in (111 Hz suits A-based
   material; 132 Hz suits C).
3. Raise *Sub Level* until you feel it on a sub or headphones, then back off
   3 dB.
4. Turn *Duck Sub To Track* on and set *Amount* so the sub steps out of the way
   of the kick. Watch the **CORRELATION** readout: above +0.5 the low end is
   mono-safe.
5. Switch *Tempo Sync* on and pick a division so the pulse locks to the track.
6. Check the result in mono. If the beat vanishes, that is the mono-maker doing
   its job — raise *Carrier* above the *Mono Below* corner, or turn
   *Headphones* on if the mix is headphone-only.

**Headphones vs speakers.** A binaural beat is a left/right difference, so
summing the band it lives in cancels it. *Headphone Mode* bypasses the
mono-maker and keeps the beat; leaving it off keeps the mix mono-compatible and
costs the beat below the crossover. The two cannot both be true below the
corner, and the plug-in does not pretend otherwise.

## Verifying the engine

```bash
cmake -S . -B build -DSOMATICPULSE_BUILD_TOOLS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --target SomaticPulseVerify
./build/SomaticPulseVerify_artefacts/Release/SomaticPulseVerify
```

The harness drives the real processor through its public parameter interface
and measures the output: binaural split frequencies, mono-maker behaviour, the
soft ceiling, ducking depth, tempo-synced pulse rate, the three beat modes
measured per channel and summed, sub-0.5 Hz pulse rates, the session envelope,
the tactile bus band limits and routing, the loudness meter against a known
tone, every factory preset, and the state round-trip. Thirty-two checks; the
build fails if any of them does.

## Layout

```
CMakeLists.txt
Source/
  ParameterIDs.h              every APVTS id in one place
  PluginProcessor.{h,cpp}     parameter layout, processBlock, state
  PluginEditor.{h,cpp}        controls, cards, layout
  FactoryPresets.{h,cpp}      the six presets, in real units
  DSP/
    BinauralOscillator.{h,cpp}  double-precision carriers, three beat modes
    SomaticPulseLFO.{h,cpp}     unipolar pulse, four shapes, tempo sync
    SolfeggioResonator.{h,cpp}  parallel TPT bandpasses + micro-detune
    PhaseSafeCrossover.{h,cpp}  ducking, LR4 mono-maker, DC block, ceiling
    TactileSend.{h,cpp}         band-pass for the transducer bus
    SessionClock.h              bounded session with fade in and out
    LoudnessMeter.{h,cpp}       K-weighted momentary loudness
    ScopeBuffer.h               lock-free audio-to-UI hand-off
  UI/
    CustomLookAndFeel.{h,cpp}   palette, typography, controls
    WaveformVisualizer.{h,cpp}  vectorscope and pulse trace
Tools/
  OfflineRender.cpp           verification harness (not built by default)
```
